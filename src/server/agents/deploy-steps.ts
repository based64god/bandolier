import { TRPCError } from "@trpc/server";

import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  makeIssueBranch,
} from "~/lib/issue-prompt";
import { getRegistryPullSecret } from "~/server/agents/github-app";
import { getIssue } from "~/server/agents/github-issues";
import {
  getGithubIdentity,
  githubGitIdentity,
  type GitIdentity,
} from "~/server/agents/github-token";
import {
  getUserRepoPermission,
  isMaintainerOrHigher,
  runUsesRepoCredentials,
} from "~/server/agents/repo-permissions";
import { type ModelCredentials } from "~/server/agents/resolve-credentials";
import {
  getRepoWebhookConfig,
  type RepoNetworkPolicy,
} from "~/server/agents/webhook-config";
import { type db } from "~/server/db";

/** A resolved git author identity plus the GitHub login it was derived from. */
export interface ResolvedGitIdentity {
  gitIdentity: GitIdentity;
  githubLogin: string | null;
}

/**
 * Attributes commits to the deploying user. Prefers their GitHub no-reply
 * address (guarantees GitHub links the commits to that account); falls back to
 * the account identity when there's no token or the lookup fails.
 */
export async function resolveGitIdentity(
  githubToken: string | null,
  fallback: GitIdentity,
): Promise<ResolvedGitIdentity> {
  let gitIdentity = fallback;
  let githubLogin: string | null = null;
  if (githubToken) {
    try {
      const gh = await getGithubIdentity(githubToken);
      gitIdentity = githubGitIdentity(gh.id, gh.login);
      githubLogin = gh.login;
    } catch (err) {
      console.warn("[bandolier:deploy] GitHub identity lookup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { gitIdentity, githubLogin };
}

/**
 * Privilege gate: a run that would spend the repo's *shared* credentials (a
 * repo-level kubeconfig or model key) is restricted to GitHub users with
 * maintainer-or-higher on the repo. A less-privileged user can only use their
 * own credentials. A no-op for repo-less runs, or runs that use only the
 * caller's own credentials. Throws FORBIDDEN otherwise.
 */
export async function assertMayUseRepoCredentials(
  database: typeof db,
  userId: string,
  repoFullName: string | undefined,
  resolved: ModelCredentials,
  githubToken: string | null,
  githubLogin: string | null,
): Promise<void> {
  if (!repoFullName) return;
  const usesRepoCreds = await runUsesRepoCredentials(
    database,
    userId,
    repoFullName,
    resolved,
  );
  if (!usesRepoCreds) return;

  if (!githubToken || !githubLogin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "A linked GitHub account is required to run on this repository's shared credentials.",
    });
  }
  const permission = await getUserRepoPermission(
    githubToken,
    repoFullName,
    githubLogin,
  );
  if (!isMaintainerOrHigher(permission)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This run would use the repository's shared credentials, which requires maintainer access or higher. Ask a maintainer to run it, or configure your own credentials in settings.",
    });
  }
}

export interface IssueContext {
  issue: { number: number; title: string; url: string; body: string } | null;
  /** The user message stored as CLAUDE_TASK (issue framing + operator task). */
  task: string;
  displayName: string;
  /** Unique working branch for an issue PR run (undefined otherwise). */
  agentBranch: string | undefined;
  /** Instructional framing for an issue PR run (undefined otherwise). */
  systemPrompt: string | undefined;
}

/**
 * Resolves the GitHub-issue context for a deploy. When an issue is selected its
 * details are fetched (for the display label) and, for a PR-output run, a unique
 * branch + instructional system prompt are built; issue-output runs skip both
 * (the harness frames its own read-only analysis). Either way the issue context
 * with the operator's task as additional context becomes the CLAUDE_TASK.
 */
export async function resolveIssueContext(
  githubToken: string | null,
  repoFullName: string | undefined,
  issueNumber: number | undefined,
  operatorTask: string,
  issueOutput: boolean,
): Promise<IssueContext> {
  let issue: IssueContext["issue"] = null;
  if (issueNumber !== undefined) {
    if (!repoFullName) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A repository is required to work on an issue.",
      });
    }
    if (!githubToken) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A linked GitHub account is required to work on an issue.",
      });
    }
    issue = await getIssue(githubToken, repoFullName, issueNumber);
    if (!issue) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Issue #${issueNumber} not found in ${repoFullName}.`,
      });
    }
  }

  const taskPreview =
    operatorTask.length > 60 ? `${operatorTask.slice(0, 60)}…` : operatorTask;
  const displayName = issue ? `#${issue.number}: ${issue.title}` : taskPreview;

  let agentBranch: string | undefined;
  let systemPrompt: string | undefined;
  if (issue && !issueOutput) {
    agentBranch = makeIssueBranch(issue.number, issue.title);
    systemPrompt = buildIssueSystemPrompt(issue, agentBranch);
  }
  const task = issue
    ? buildIssueUserMessage(issue, operatorTask)
    : operatorTask;

  return { issue, task, displayName, agentBranch, systemPrompt };
}

export interface RepoRunConfig {
  agentImage: string | undefined;
  imagePullSecret: { registry: string; dockerConfigJson: string } | undefined;
  repoSystemPrompt: string | undefined;
  networkPolicy: RepoNetworkPolicy | undefined;
}

/**
 * Loads the per-repo run configuration: a harness image override (with pull
 * credentials for a private ghcr.io package), the repo-attached system prompt,
 * and the network-policy config — one consolidated config-row read. Best-effort:
 * a lookup failure logs and leaves the fields unset (the built-in defaults)
 * rather than blocking the deploy. A no-op for repo-less runs.
 */
export async function loadRepoRunConfig(
  database: typeof db,
  repoFullName: string | undefined,
  githubToken: string | null,
): Promise<RepoRunConfig> {
  const config: RepoRunConfig = {
    agentImage: undefined,
    imagePullSecret: undefined,
    repoSystemPrompt: undefined,
    networkPolicy: undefined,
  };
  if (!repoFullName) return config;

  try {
    const repoConfig = await getRepoWebhookConfig(database, repoFullName);
    config.agentImage = repoConfig?.agentImage ?? undefined;
    config.repoSystemPrompt = repoConfig?.systemPrompt ?? undefined;
    config.networkPolicy = repoConfig?.networkPolicy;
  } catch (err) {
    console.warn("[bandolier:deploy] repo config lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // A custom image on a private ghcr.io package needs pull credentials — use the
  // deploying user's GitHub OAuth token (GHCR rejects App installation tokens).
  // Best-effort: no token leaves the cluster to pull with its own node creds.
  if (config.agentImage) {
    config.imagePullSecret =
      getRegistryPullSecret(config.agentImage, githubToken) ?? undefined;
  }
  return config;
}
