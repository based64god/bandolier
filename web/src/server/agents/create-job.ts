import type * as k8s from "@kubernetes/client-node";

import type { AwsCredentials } from "~/server/agents/aws";
import { env } from "~/env";
import {
  cpuToMillicores,
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  memoryToBytes,
  validateCpuQuantity,
  validateMemoryQuantity,
  type ComputeSpec,
} from "~/lib/compute";
import { ingestToken } from "~/lib/ingest";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import {
  agentEgressBlockedCidrs,
  buildCustomNetworkPolicyBody,
  buildNetworkPolicyBody,
  NETWORK_POLICY_NAME,
  type NetworkPolicyOptions,
} from "~/server/agents/network-policy";
import { providerForCredentials } from "~/server/agents/resolve-credentials";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import {
  getBatchV1Api,
  getCoreV1Api,
  getNetworkingV1Api,
  getPolicyV1Api,
} from "~/server/k8s/client";

/** Seconds a finished Job (and its pod) is retained before Kubernetes deletes it. */
export const JOB_TTL_SECONDS = 7 * 24 * 3600; // one week

/**
 * Default cap on Claude agentic turns when the deploy form leaves it blank.
 * Effectively unlimited — a run only stops early if the form sets a value.
 */
export const DEFAULT_MAX_TURNS = Number.MAX_SAFE_INTEGER;

/**
 * Default agent harness image. A repo's `agentImage` config (DB) overrides it
 * per repo; there is no server-wide env override.
 */
export const DEFAULT_HARNESS_IMAGE =
  "ghcr.io/based64god/bandolier-agent-harness:latest";

/**
 * Namespace used when a job spec doesn't carry one. In practice every caller
 * passes a namespace derived from the repo, so this is just a safety default.
 */
const DEFAULT_NAMESPACE = "bandolier-agents";

// ── Kubernetes resource bootstrap ─────────────────────────────────────────────

export async function ensureNamespace(
  namespace: string,
  kubeconfig: string,
  networkPolicy?: NetworkPolicyOptions,
): Promise<boolean> {
  let created = false;
  try {
    await getCoreV1Api(kubeconfig).createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: { "app.kubernetes.io/managed-by": "bandolier" },
        },
      },
    });
    created = true;
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
  }

  // Isolate agents in the namespace (no-op if disabled). Done after the
  // namespace is guaranteed to exist so the policy has somewhere to go.
  await ensureNetworkPolicy(namespace, kubeconfig, networkPolicy);
  return created;
}

/**
 * Network isolation for agent pods: denies all inbound traffic and restricts
 * egress to DNS + the public internet, with the cluster's own (private) ranges
 * blocked. An agent can clone from GitHub and reach its model provider but can't
 * reach other pods or in-cluster services. Requires a policy-enforcing CNI
 * (Calico/Cilium) to take effect — it's a harmless no-op under kindnet.
 *
 * Per-repo toggles (`opts`) can loosen the egress rules: `allowPrivateEgress`
 * drops the in-cluster CIDR block, and `allowAllPortsEgress` lifts the 80/443
 * port restriction. Both default off, preserving the locked-down baseline. A
 * repo's custom policy YAML (advanced config, validated on save) replaces the
 * built-in policy — toggles included — entirely. The policy is re-applied on
 * every deploy (create, else replace) so flipping a toggle or editing the YAML
 * takes effect on an existing namespace's next run rather than being pinned to
 * whatever it was first created with.
 */
async function ensureNetworkPolicy(
  namespace: string,
  kubeconfig: string,
  opts?: NetworkPolicyOptions,
): Promise<void> {
  if (env.AGENT_NETWORK_POLICY !== "true") return;

  // A custom policy throws on unparseable YAML, failing the deploy closed —
  // better no run than a run without the policy the admin configured.
  const body = opts?.policyYaml
    ? buildCustomNetworkPolicyBody(namespace, opts.policyYaml)
    : buildNetworkPolicyBody(namespace, agentEgressBlockedCidrs(), opts);

  const api = getNetworkingV1Api(kubeconfig);
  try {
    await api.createNamespacedNetworkPolicy({ namespace, body });
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
    // Already present — replace it so a flipped per-repo toggle takes effect
    // (the policy isn't pinned to whatever it was first created with).
    await api.replaceNamespacedNetworkPolicy({
      name: NETWORK_POLICY_NAME,
      namespace,
      body,
    });
  }
}

export async function ensureServiceAccount(
  namespace: string,
  name: string,
  kubeconfig: string,
): Promise<boolean> {
  try {
    await getCoreV1Api(kubeconfig).createNamespacedServiceAccount({
      namespace,
      body: {
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "bandolier" },
        },
        automountServiceAccountToken: false,
      },
    });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 409) return false;
    throw err;
  }
}

// ── Job creation ─────────────────────────────────────────────────────────────

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef: { name: string; key: string; optional: boolean };
  };
};

export interface JobSpec {
  task: string;
  /**
   * Instructional framing that surrounds the task/issue context — objective,
   * branch rules, commit steps. Passed to the harness as CLAUDE_SYSTEM_PROMPT
   * and appended to Claude's system prompt, so the user message stays the raw
   * issue/form context. Only set for issue mode; the harness builds the
   * repo/interactive framing itself.
   */
  systemPrompt?: string;
  /** Human-readable label shown in the dashboard (issue title or task preview). */
  displayName: string;
  /** Kubernetes namespace to deploy into. Falls back to the default namespace. */
  namespace?: string;
  repoUrl?: string;
  branch: string;
  model: string;
  /**
   * Reasoning-effort level for the run (low|medium|high|xhigh|max), passed to
   * the `claude` CLI as --effort. Applies to every provider — non-Anthropic
   * backends get the thinking budget mapped by the harness's embedded proxy.
   * Unset = the harness/CLI default.
   */
  effort?: string;
  maxTurns?: number;
  /**
   * Out-of-band model (the latest Sonnet) the harness uses to write the PR title
   * and description from the commits, independent of `model`. Only meaningful for
   * PR-producing runs; omit otherwise.
   */
  prWriterModel?: string;
  /**
   * When true the agent runs as a long-lived interactive session: Claude is
   * driven over streaming JSON and waits for user input between turns, which the
   * dashboard delivers via the input-polling callback.
   */
  interactive?: boolean;
  /**
   * What the run produces when it finishes: a pull request (default), a GitHub
   * issue, or a PR review. In issue mode the harness runs the agent read-only
   * and opens one issue written from the transcript. In review mode it analyses
   * an existing pull request read-only and the review is submitted server-side
   * in the bot voice (never the acting user's credentials) — see reviewPrNumber.
   * Both non-PR modes require `repoFullName`.
   */
  outputType?: "pr" | "issue" | "review";
  /**
   * The number of the pull request a review run reviews (review mode only). The
   * harness fetches its diff read-only; the server posts the resulting review to
   * this PR in the bot voice. Passed to the harness as REVIEW_PR_NUMBER.
   */
  reviewPrNumber?: string;
  /**
   * The html_url of the pull request a review run reviews. Recorded on the run
   * row (task_run.reviewed_pr_url) at creation so a push to that PR's branch can
   * find the review run to re-review, and so a comment-resume can skip it.
   */
  reviewedPrUrl?: string;
  /**
   * For a review run, whether its review is posted in the acting user's voice
   * (their GitHub token) instead of the bandolier[bot] voice. True for
   * dashboard-created reviews; unset/false for webhook-triggered ones. Recorded
   * on the run row; the review-submit endpoint reads it to pick the token.
   */
  reviewAsUser?: boolean;
  gitName?: string;
  gitEmail?: string;
  /** Set for issue tasks (dashboard or webhook). */
  issueNumber?: string;
  /** Link to the originating GitHub issue (issue tasks). */
  issueUrl?: string;
  /** The (unique) working branch the harness should use, referenced in the prompt. */
  agentBranch?: string;
  /**
   * Base branch for the run's pull request (GITHUB_BASE_BRANCH). Only needed
   * when it differs from `branch` — e.g. a resumed run clones the existing PR
   * head branch, but its PR still targets the original base.
   */
  baseBranch?: string;
  /**
   * Job name of the run this one resumes (a follow-up comment on the parent's
   * issue or PR). Recorded on the run row and pod so the UI can surface the
   * lineage, and it makes the harness fetch the parent's persisted transcript
   * as context before starting.
   */
  parentJobName?: string;
  /** The parent run's display name, surfaced in the UI next to the lineage. */
  parentDisplayName?: string;
  /**
   * Head commit SHA of the pull request whose failing CI auto-resumed this run.
   * Recorded on the run row (task_run.ci_resume_sha) so the webhook's CI-failure
   * handler can de-duplicate failure events for the same commit and cap how many
   * times a PR auto-resumes. Only set on CI-triggered resumes; unset otherwise.
   */
  ciResumeSha?: string;
  /**
   * Existing remote branch the run resumes work on (RESUME_BRANCH): the harness
   * clones it instead of cutting a fresh branch, measures new work against its
   * remote tip, and pushes follow-up commits to the parent's open PR. Callers
   * must also set `branch` to the same value so the clone lands on it.
   */
  resumeBranch?: string;
  /** "owner/repo" — used by the harness to interact with the GitHub API. */
  repoFullName?: string;
  /** Human label of who/what created the task (e.g. user email, or issue opener). */
  createdBy?: string;
  /**
   * Bandolier user id that owns this agent — the deploying user, or (for webhook
   * tasks) the user linked to the GitHub account that triggered the event. Pods
   * are labelled with it so each user's overview can list only their own agents.
   */
  userId: string;
  /**
   * The acting user's GitHub OAuth token. Stored in the per-job secret and used
   * by the harness to clone, commit, and open the PR as that user.
   */
  githubToken?: string;
  /**
   * The acting user's AWS credentials. When provided, the agent runs on Bedrock
   * with these. The caller must validate them (STS) before deploy.
   */
  awsCredentials?: AwsCredentials;
  /** The acting user's Anthropic API key. Used when no AWS credentials are given. */
  anthropicApiKey?: string;
  /**
   * The acting user's Claude subscription OAuth token (`claude setup-token`).
   * An alternative to `anthropicApiKey`; injected as CLAUDE_CODE_OAUTH_TOKEN,
   * which the claude CLI reads directly from the environment.
   */
  anthropicOauthToken?: string;
  /**
   * The acting user's OpenAI API key. Used when an OpenAI model is selected;
   * routed through the embedded gollm proxy's `openai` backend (injected as
   * OPENAI_API_KEY).
   */
  openaiApiKey?: string;
  /**
   * The acting user's ChatGPT-subscription auth (contents of `codex login`'s
   * ~/.codex/auth.json). An alternative to `openaiApiKey`; routed through the
   * proxy's `chatgpt` backend, which reads it inline (injected as
   * CODEX_AUTH_JSON — no file is written in the pod).
   */
  codexAuthJson?: string;
  /**
   * The acting user's Google Cloud project credentials JSON (service-account
   * key). Used when a Gemini model is selected; routed through the proxy's
   * `vertex` backend, which reads the key inline (injected as
   * GOOGLE_APPLICATION_CREDENTIALS_JSON) and derives the project id from it.
   */
  geminiApiKey?: string;
  /**
   * A gollm-proxied provider credential (Groq, OpenRouter, vLLM, … — see
   * ~/server/agents/gollm-catalog): the provider id plus the env vars the pod
   * needs, already mapped from the stored credential. The harness routes the
   * run through its embedded proxy with this provider as the backend.
   */
  customProvider?: {
    provider: string;
    env: Record<string, string>;
  };
  /** The acting user's kubeconfig — the cluster the agent is deployed into. Required. */
  kubeconfig: string;
  /**
   * Per-repo override for the harness container image. When unset, the built-in
   * DEFAULT_HARNESS_IMAGE is used.
   */
  agentImage?: string;
  /**
   * Image-pull credentials for a private custom `agentImage`. When set, a
   * `kubernetes.io/dockerconfigjson` Secret holding `dockerConfigJson` is created
   * (owned by the Job, so GC'd with it) and referenced as an `imagePullSecret` on
   * the pod, letting the cluster pull from a registry it has no standing
   * credentials for — e.g. a private `ghcr.io` package authenticated with the
   * Bandolier GitHub App's installation token. Unset = rely on the cluster's own
   * node credentials (public images need none).
   */
  imagePullSecret?: { registry: string; dockerConfigJson: string };
  /**
   * Repo-attached system prompt: an admin-configured blanket instruction for the
   * repo, appended to whatever system-prompt framing the harness builds for the
   * run (every mode and provider). Passed as REPO_SYSTEM_PROMPT — kept distinct
   * from `systemPrompt` (CLAUDE_SYSTEM_PROMPT), which is the harness's own
   * instructional framing. Unset = no repo-wide prompt.
   */
  repoSystemPrompt?: string;
  /**
   * CPU / memory limit for the agent pod, resolved by the caller from the
   * per-task override and the repo/user defaults (see resolveCompute). Unset
   * fields use the built-in DEFAULT_CPU_LIMIT / DEFAULT_MEMORY_LIMIT. Values
   * are re-validated here so an unvalidated caller can't create a pod with a
   * malformed or out-of-bounds quantity.
   */
  compute?: ComputeSpec;
  /**
   * Per-repo agent NetworkPolicy configuration (admin-set in repo config):
   * egress-loosening toggles, or a raw custom policy YAML that replaces the
   * built-in policy entirely. Applied to the namespace's policy before the Job
   * is created. Unset = the default isolated egress.
   */
  networkPolicy?: NetworkPolicyOptions;
}

/**
 * The pod's resource requests/limits for a run's (validated) compute config.
 * Limits come from the spec, falling back to the built-in defaults; requests
 * are half the limit, so the scheduler's bin-packing footprint scales with
 * the run's configured size while still leaving burst headroom.
 */
export function podResources(compute?: ComputeSpec): {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
} {
  const validated: { cpu?: string; memory?: string } = {};
  for (const [key, value, validate] of [
    ["cpu", compute?.cpu, validateCpuQuantity],
    ["memory", compute?.memory, validateMemoryQuantity],
  ] as const) {
    if (value !== undefined) {
      const validation = validate(value);
      if (!validation.valid) throw new Error(validation.error);
      // Use the normalized quantity so a bare "8" limit becomes "8Gi", not
      // 8 bytes, if it ever reaches the pod without going through the UI paths.
      validated[key] = validation.normalized;
    }
  }

  const cpuLimit = validated.cpu ?? DEFAULT_CPU_LIMIT;
  const memoryLimit = validated.memory ?? DEFAULT_MEMORY_LIMIT;
  // Emit requests in fixed units (millicores / Mi) so halving any valid limit
  // stays a whole-number Kubernetes quantity.
  const cpuRequest = `${Math.ceil(cpuToMillicores(cpuLimit)! / 2)}m`;
  const memoryRequest = `${Math.ceil(memoryToBytes(memoryLimit)! / 2 / 1024 ** 2)}Mi`;
  return {
    requests: { cpu: cpuRequest, memory: memoryRequest },
    limits: { cpu: cpuLimit, memory: memoryLimit },
  };
}

/** Per-job secret holding the acting user's credentials (GitHub / AWS / Anthropic). */
function userSecretName(jobName: string): string {
  return `${jobName}-creds`;
}

/** Per-job image-pull secret (dockerconfigjson) for a private agent image. */
function pullSecretName(jobName: string): string {
  return `${jobName}-pull`;
}

/** Per-job PodDisruptionBudget pinning the agent pod until the run finishes. */
function pdbName(jobName: string): string {
  return `${jobName}-pdb`;
}

/**
 * A resolved model provider: its type/model plus the credential wiring for the
 * run, derived from the spec in one place. `secretRefs` and `secretData` are the
 * single source of truth for the per-provider credential mapping — the pod's env
 * refs and the secret payload both come from this descriptor, so they can't drift
 * out of sync the way the two hand-kept copies used to.
 */
export interface ProviderDescriptor {
  type: "bedrock" | "anthropic" | "openai" | "gemini" | "custom";
  model: string;
  /** Non-secret provider env vars (e.g. CLAUDE_CODE_USE_BEDROCK, AWS_REGION). */
  plainEnv: EnvVar[];
  /**
   * Credential env vars sourced from the per-job secret. `optional` mirrors the
   * secret ref's `optional` flag (an absent key doesn't fail the pod).
   */
  secretRefs: { key: string; optional?: boolean }[];
  /** Credential values that land in the per-job secret's stringData. */
  secretData: Record<string, string>;
}

/**
 * Picks the run's provider from the spec's credentials and derives its full
 * credential wiring (env refs + secret payload) once. Precedence comes from
 * the provider registry in resolve-credentials.ts (Bedrock beats Anthropic,
 * which beats OpenAI, which beats Gemini; within a provider an API key beats
 * a subscription credential). Throws when the spec carries no model
 * credentials at all — there is no server fallback.
 */
export function resolveProvider(spec: JobSpec): ProviderDescriptor {
  const model = spec.model;

  // A catalog custom provider carries its own env mapping and gollm backend id.
  if (spec.customProvider) {
    return proxiedProvider(
      "custom",
      model,
      spec.customProvider.provider,
      spec.customProvider.env,
    );
  }

  // Route by the single provider precedence the registry defines, so this
  // path can't drift from the resolver. The spec spells the Bedrock field
  // `awsCredentials`; adapt it to the registry's `aws`.
  const provider = providerForCredentials({
    aws: spec.awsCredentials ?? null,
    anthropicApiKey: spec.anthropicApiKey ?? null,
    anthropicOauthToken: spec.anthropicOauthToken ?? null,
    openaiApiKey: spec.openaiApiKey ?? null,
    codexAuthJson: spec.codexAuthJson ?? null,
    geminiApiKey: spec.geminiApiKey ?? null,
  });

  if (provider === "bedrock") {
    const aws = spec.awsCredentials!;
    const secretData: Record<string, string> = {
      AWS_ACCESS_KEY_ID: aws.accessKeyId,
      AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
    };
    // Only include a session token for temporary credentials; an empty value
    // would break SigV4 for permanent IAM keys.
    if (aws.sessionToken) secretData.AWS_SESSION_TOKEN = aws.sessionToken;
    return {
      type: "bedrock",
      model,
      plainEnv: [
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
        { name: "AWS_REGION", value: aws.region },
      ],
      // The session token ref is always present but optional, so permanent and
      // temporary credentials produce the same pod manifest shape.
      secretRefs: [
        { key: "AWS_ACCESS_KEY_ID" },
        { key: "AWS_SECRET_ACCESS_KEY" },
        { key: "AWS_SESSION_TOKEN", optional: true },
      ],
      secretData,
    };
  }

  if (provider === "anthropic") {
    // An API key and a subscription OAuth token are two routes to the same
    // provider; the key takes precedence, so exactly one lands in the secret
    // (matching the env var the pod references).
    const [key, value] = spec.anthropicApiKey
      ? (["ANTHROPIC_API_KEY", spec.anthropicApiKey] as const)
      : (["CLAUDE_CODE_OAUTH_TOKEN", spec.anthropicOauthToken!] as const);
    return {
      type: "anthropic",
      model,
      plainEnv: [],
      secretRefs: [{ key }],
      secretData: { [key]: value },
    };
  }

  if (provider === "openai") {
    // OpenAI is proxied like every non-native provider: the harness routes its
    // embedded gollm proxy by BANDOLIER_LLM_PROVIDER. An API key uses gollm's
    // `openai` backend; the ChatGPT-subscription auth.json (from `codex login`)
    // uses the `chatgpt` backend, which reads CODEX_AUTH_JSON inline. The key
    // takes precedence.
    const [backend, key, value] = spec.openaiApiKey
      ? (["openai", "OPENAI_API_KEY", spec.openaiApiKey] as const)
      : (["chatgpt", "CODEX_AUTH_JSON", spec.codexAuthJson!] as const);
    return proxiedProvider("openai", model, backend, { [key]: value });
  }

  if (provider === "gemini") {
    // Gemini runs against Vertex AI through the proxy's `vertex` backend, which
    // reads the service-account key JSON inline from
    // GOOGLE_APPLICATION_CREDENTIALS_JSON (the project id is derived from the
    // key itself). No file is written in the pod.
    return proxiedProvider("gemini", model, "vertex", {
      GOOGLE_APPLICATION_CREDENTIALS_JSON: spec.geminiApiKey!,
    });
  }

  // Only user-provided credentials are ever used — there is no server fallback.
  throw new Error(
    "No model credentials available. Configure AWS, Anthropic, OpenAI, or Gemini credentials in account settings.",
  );
}

/**
 * Builds a descriptor for a proxied provider: BANDOLIER_LLM_PROVIDER names the
 * gollm backend the harness routes to, and every credential env var becomes a
 * per-job secret ref. Shared by the OpenAI/Gemini paths and the generic
 * custom-provider path (which they now match — the harness treats all three
 * identically).
 */
function proxiedProvider(
  type: ProviderDescriptor["type"],
  model: string,
  backend: string,
  env: Record<string, string>,
): ProviderDescriptor {
  return {
    type,
    model,
    plainEnv: [{ name: "BANDOLIER_LLM_PROVIDER", value: backend }],
    secretRefs: Object.keys(env).map((key) => ({ key })),
    secretData: env,
  };
}

/**
 * The pod's full env var list for a run: provider credentials (from the resolved
 * descriptor), the task/repo/git context, the run's optional feature toggles, and
 * the ingest/interactive callback URLs. `userRef` sources a value from the
 * per-job secret; the GitHub token ref is always emitted (optional) so tokenless
 * runs share the same manifest shape.
 */
export function buildEnvVars(
  spec: JobSpec,
  jobName: string,
  provider: ProviderDescriptor,
): EnvVar[] {
  // All credentials come from the per-job secret created alongside the job.
  const userRef = (key: string, optional = false): EnvVar => ({
    name: key,
    valueFrom: {
      secretKeyRef: { name: userSecretName(jobName), key, optional },
    },
  });

  const envVars: EnvVar[] = [
    { name: "CLAUDE_TASK", value: spec.task },
    { name: "CLAUDE_MODEL", value: spec.model },
    { name: "AGENT_TITLE", value: spec.displayName },
    { name: "REPO_URL", value: spec.repoUrl ?? "" },
    { name: "BRANCH", value: spec.branch },
    { name: "GIT_NAME", value: spec.gitName ?? "Bandolier Agent" },
    {
      name: "GIT_EMAIL",
      value: spec.gitEmail ?? "bandolier-agent@bandolier.local",
    },
    ...provider.plainEnv,
    ...provider.secretRefs.map((r) => userRef(r.key, r.optional)),
    userRef("GITHUB_TOKEN", true),
  ];

  // Turns are unlimited by default; the form value sets a real cap.
  envVars.push({
    name: "MAX_TURNS",
    value: String(spec.maxTurns ?? DEFAULT_MAX_TURNS),
  });
  // Reasoning effort (the `claude` CLI's --effort). Every provider runs through
  // the claude CLI — the harness's embedded proxy maps the thinking budget for
  // non-Anthropic backends — so the value is forwarded unconditionally. The
  // harness validates it and ignores an unknown one.
  if (spec.effort) {
    envVars.push({ name: "CLAUDE_EFFORT", value: spec.effort });
  }
  if (spec.prWriterModel) {
    envVars.push({ name: "PR_WRITER_MODEL", value: spec.prWriterModel });
  }
  if (spec.issueNumber) {
    envVars.push({ name: "GITHUB_ISSUE_NUMBER", value: spec.issueNumber });
  }
  if (spec.repoFullName) {
    envVars.push({ name: "GITHUB_REPO", value: spec.repoFullName });
  }
  if (spec.agentBranch) {
    envVars.push({ name: "AGENT_BRANCH", value: spec.agentBranch });
  }
  if (spec.baseBranch) {
    envVars.push({ name: "GITHUB_BASE_BRANCH", value: spec.baseBranch });
  }
  if (spec.resumeBranch) {
    envVars.push({ name: "RESUME_BRANCH", value: spec.resumeBranch });
  }
  if (spec.systemPrompt) {
    envVars.push({ name: "CLAUDE_SYSTEM_PROMPT", value: spec.systemPrompt });
  }
  if (spec.repoSystemPrompt) {
    envVars.push({
      name: "REPO_SYSTEM_PROMPT",
      value: spec.repoSystemPrompt,
    });
  }
  if (spec.outputType === "issue") {
    envVars.push({ name: "OUTPUT_TYPE", value: "issue" });
  }
  if (spec.outputType === "review") {
    envVars.push({ name: "OUTPUT_TYPE", value: "review" });
    if (spec.reviewPrNumber) {
      envVars.push({ name: "REVIEW_PR_NUMBER", value: spec.reviewPrNumber });
    }
    // The harness POSTs the structured review here; the server posts it to the
    // PR in the bot voice (never the acting user's credentials). Same per-job
    // HMAC as the ingest callback authenticates it.
    envVars.push({
      name: "BANDOLIER_REVIEW_URL",
      value: `${env.BETTER_AUTH_URL}/api/agent-runs/review`,
    });
  }

  // The ingest callback, the artifact upload, and the interactive input poll are
  // all authenticated by the same per-job HMAC token; inject it (and the job
  // name) for every run, then add the feature-specific callback URLs.
  //
  // The ingest callback runs unconditionally — not just when S3 artifacts are
  // configured. It's how the harness reports the run's structured output (the
  // PR/issue URL) back to the database so it survives pod-log loss (TTL
  // deletion, eviction, node failure). The transcript-to-S3 upload is a separate
  // concern that the endpoint layers on only when a bucket is set; coupling the
  // two used to mean a deployment without S3 lost its output the moment its pod
  // logs went away.
  envVars.push(
    { name: "BANDOLIER_JOB", value: jobName },
    {
      name: "BANDOLIER_INGEST_TOKEN",
      value: ingestToken(jobName, env.BETTER_AUTH_SECRET),
    },
    {
      name: "BANDOLIER_INGEST_URL",
      value: `${env.BETTER_AUTH_URL}/api/agent-runs`,
    },
  );
  // Resumed runs fetch their parent's persisted transcript from this endpoint
  // (same URL as ingest, GET; same per-job token) before starting, so the new
  // run carries the full context of the run it continues.
  if (spec.parentJobName) {
    envVars.push({
      name: "BANDOLIER_CONTEXT_URL",
      value: `${env.BETTER_AUTH_URL}/api/agent-runs`,
    });
  }
  if (spec.interactive) {
    envVars.push(
      { name: "INTERACTIVE", value: "1" },
      {
        name: "BANDOLIER_INPUT_URL",
        value: `${env.BETTER_AUTH_URL}/api/agent-input`,
      },
      // ACP relay: the harness proxy pulls client→agent frames from / pushes
      // agent→client frames to this endpoint (GET/POST on the same URL).
      {
        name: "BANDOLIER_ACP_URL",
        value: `${env.BETTER_AUTH_URL}/api/acp`,
      },
    );
  }

  return envVars;
}

/** Owner reference tying a dependent resource's lifecycle to the given Job. */
type JobOwnerRef = {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  blockOwnerDeletion: boolean;
};

/**
 * The Job manifest for a run: metadata labels/annotations (mirrored onto the pod
 * template, which the dashboard reads), the locked-down pod spec (root user, no
 * retries, isolated workspace), and the resolved env vars. Pure — it constructs
 * the body but performs no cluster calls.
 */
export function buildJobManifest(
  spec: JobSpec,
  jobName: string,
  ns: string,
  envVars: EnvVar[],
): k8s.V1Job {
  // Annotations carried on both the Job and the pod (the dashboard reads pods).
  // The repo is an annotation (it contains "/", invalid in a label) and is used
  // by the overview to show which repository an agent belongs to.
  const annotations: Record<string, string> = {
    "bandolier.io/display-name": spec.displayName,
    ...(spec.repoFullName && { "bandolier.io/repo": spec.repoFullName }),
    ...(spec.issueNumber && { "bandolier.io/github-issue": spec.issueNumber }),
    ...(spec.issueUrl && { "bandolier.io/issue-url": spec.issueUrl }),
    ...((spec.outputType === "issue" || spec.outputType === "review") && {
      "bandolier.io/output-type": spec.outputType,
    }),
    ...(spec.createdBy && { "bandolier.io/created-by": spec.createdBy }),
    // Lineage of a resumed run, read by the dashboard to show what it continues.
    ...(spec.parentJobName && {
      "bandolier.io/parent-job": spec.parentJobName,
    }),
    ...(spec.parentDisplayName && {
      "bandolier.io/parent-name": spec.parentDisplayName,
    }),
  };

  // Scopes the cross-repo overview to the user who spawned the agent (queried via
  // a label selector, so no cluster-wide pod scan is needed).
  const spawnedBy = spawnedByLabelValue(spec.userId);

  // Marks interactive agents so the dashboard can surface them separately (a
  // label, not an annotation, so it's queryable and visible on every pod).
  const interactiveLabels: Record<string, string> = spec.interactive
    ? { "bandolier.io/interactive": "true" }
    : {};

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: ns,
      labels: {
        app: "bandolier-agent",
        "app.kubernetes.io/managed-by": "bandolier",
        [SPAWNED_BY_LABEL]: spawnedBy,
        ...interactiveLabels,
      },
      annotations,
    },
    spec: {
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            app: "bandolier-agent",
            "app.kubernetes.io/managed-by": "bandolier",
            "bandolier.io/job": jobName,
            [SPAWNED_BY_LABEL]: spawnedBy,
            ...interactiveLabels,
            "bandolier.io/source": spec.issueNumber
              ? "github-issue"
              : "dashboard",
          },
          annotations,
        },
        spec: {
          serviceAccountName: "bandolier-agent",
          restartPolicy: "Never",
          // Pull a private custom image via the per-job dockerconfigjson secret
          // created below (e.g. a private ghcr.io package authenticated with the
          // GitHub App installation token). Omitted entirely for public images.
          ...(spec.imagePullSecret && {
            imagePullSecrets: [{ name: pullSecretName(jobName) }],
          }),
          // Run as root: the harness image is built around HOME=/root with the
          // agent CLIs in /root/.local/bin (see agent-harness/Dockerfile), so a
          // non-root uid can't read its tools or write $HOME (e.g. ~/.gemini).
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            fsGroup: 0,
          },
          containers: [
            {
              name: "harness",
              image: spec.agentImage ?? DEFAULT_HARNESS_IMAGE,
              imagePullPolicy: "Always",
              env: envVars,
              resources: podResources(spec.compute),
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
          ],
          volumes: [{ name: "workspace", emptyDir: {} }],
        },
      },
    },
  };
}

/**
 * Creates the per-job secrets owned by the Job (so they're GC'd with it): the
 * creds secret holding the resolved provider's credentials plus the GitHub token,
 * and — for a private custom image — the dockerconfigjson pull secret the pod's
 * imagePullSecrets reference.
 */
export async function createSecrets(
  spec: JobSpec,
  jobName: string,
  ns: string,
  provider: ProviderDescriptor,
  jobOwnerRef: JobOwnerRef,
): Promise<void> {
  const kc = spec.kubeconfig;

  // The provider descriptor is the single source of truth for which credential
  // keys land in the secret; the pod's env refs come from the same descriptor,
  // so the two can't drift apart.
  const stringData: Record<string, string> = { ...provider.secretData };
  if (spec.githubToken) stringData.GITHUB_TOKEN = spec.githubToken;

  await getCoreV1Api(kc).createNamespacedSecret({
    namespace: ns,
    body: {
      metadata: {
        name: userSecretName(jobName),
        namespace: ns,
        labels: { "app.kubernetes.io/managed-by": "bandolier" },
        ownerReferences: [jobOwnerRef],
      },
      type: "Opaque",
      stringData,
    },
  });

  // When the custom image lives on a private registry, create the dockerconfigjson
  // secret the pod's imagePullSecrets reference. Owned by the Job like the creds
  // secret, so it's GC'd together with the run.
  if (spec.imagePullSecret) {
    await getCoreV1Api(kc).createNamespacedSecret({
      namespace: ns,
      body: {
        metadata: {
          name: pullSecretName(jobName),
          namespace: ns,
          labels: { "app.kubernetes.io/managed-by": "bandolier" },
          ownerReferences: [jobOwnerRef],
        },
        type: "kubernetes.io/dockerconfigjson",
        stringData: {
          ".dockerconfigjson": spec.imagePullSecret.dockerConfigJson,
        },
      },
    });
  }
}

/**
 * Records the run so it can be listed/inspected after the Job's TTL deletes the
 * pod. Inserted for every run, not just when S3 is configured: the harness
 * reports the run's structured output (PR/issue URL) into this row via the
 * ingest callback, and that output must outlive the pod logs regardless of
 * whether transcript artifacts are also being stored. The transcriptKey column
 * stays null when there's no bucket to upload to.
 */
export async function recordRun(spec: JobSpec, jobName: string, ns: string) {
  await db.insert(taskRun).values({
    jobName,
    namespace: ns,
    displayName: spec.displayName,
    createdBy: spec.createdBy ?? null,
    // The canonical owner id (same value tagged on the pod via SPAWNED_BY_LABEL),
    // so the run's transcript stays ownership-checkable after the pod is gone.
    spawnedBy: spec.userId,
    repoFullName: spec.repoFullName ?? null,
    issueNumber: spec.issueNumber ?? null,
    // The PR a review run reviews (its input), so a push to that PR's branch can
    // find this run to re-review and a comment-resume can skip it. Null for
    // every non-review run.
    reviewedPrUrl: spec.reviewedPrUrl ?? null,
    // Whether a review run posts in the user's voice (dashboard) vs the bot's
    // (webhook). Null for non-review runs; the review endpoint reads it.
    reviewAsUser: spec.reviewAsUser ?? null,
    parentJobName: spec.parentJobName ?? null,
    ciResumeSha: spec.ciResumeSha ?? null,
    // The resolved image (same fallback as the pod spec), so the harness
    // contract version the run later reports is attributable to this image.
    agentImage: spec.agentImage ?? DEFAULT_HARNESS_IMAGE,
  });
}

export async function createAgentJob(spec: JobSpec): Promise<string> {
  const ns = spec.namespace ?? DEFAULT_NAMESPACE;
  const jobName = `bandolier-agent-${Date.now()}`;

  // Resolves the provider (and its credential wiring) or throws when the spec
  // carries no model credentials — there is no server fallback.
  const provider = resolveProvider(spec);

  const kc = spec.kubeconfig;
  if (!kc) {
    throw new Error("No kubeconfig available. Add one in account settings.");
  }

  // Bootstrap shared (non-secret) resources.
  const [nsCreated, saCreated] = await Promise.all([
    ensureNamespace(ns, kc, spec.networkPolicy),
    ensureServiceAccount(ns, "bandolier-agent", kc),
  ]);
  console.log("[bandolier:deploy] resources", {
    namespace: nsCreated ? "created" : "exists",
    serviceAccount: saCreated ? "created" : "exists",
  });
  console.log("[bandolier:deploy] provider", {
    type: provider.type,
    model: provider.model,
  });

  const envVars = buildEnvVars(spec, jobName, provider);

  const job = await getBatchV1Api(kc).createNamespacedJob({
    namespace: ns,
    body: buildJobManifest(spec, jobName, ns, envVars),
  });

  // Owner reference tying a dependent resource's lifecycle to the Job, so
  // Kubernetes garbage-collects it when the Job is deleted (manually or via TTL).
  const jobOwnerRef: JobOwnerRef = {
    apiVersion: "batch/v1",
    kind: "Job",
    name: jobName,
    uid: job.metadata?.uid ?? "",
    blockOwnerDeletion: true,
  };

  // Agents run with backoffLimit 0, so a single eviction permanently fails the
  // run. Voluntary disruptions (autoscaler consolidation, kubectl drain, the
  // descheduler) all go through the eviction API, which refuses evictions that
  // would violate a PodDisruptionBudget — so a PDB covering the pod pins it in
  // place until the run finishes, regardless of which autoscaler (if any) backs
  // the cluster. minAvailable must be an integer here: percentages require a
  // scale subresource, which Jobs don't have. Best-effort — a cluster or role
  // that can't create PDBs leaves the run unprotected but still deployable.
  try {
    await getPolicyV1Api(kc).createNamespacedPodDisruptionBudget({
      namespace: ns,
      body: {
        metadata: {
          name: pdbName(jobName),
          namespace: ns,
          labels: { "app.kubernetes.io/managed-by": "bandolier" },
          ownerReferences: [jobOwnerRef],
        },
        spec: {
          minAvailable: 1,
          selector: { matchLabels: { "bandolier.io/job": jobName } },
        },
      },
    });
  } catch (error) {
    console.warn(
      "[bandolier:deploy] PDB creation failed; agent pod is not protected from voluntary eviction",
      { job: jobName, error },
    );
  }

  // Store the acting user's credentials (and, for a private image, the pull
  // secret) in per-job secrets owned by the Job, so they're GC'd with it.
  await createSecrets(spec, jobName, ns, provider, jobOwnerRef);

  await recordRun(spec, jobName, ns);

  console.log("[bandolier:deploy] job created", {
    job: jobName,
    namespace: ns,
    github: !!spec.githubToken,
    provider: provider.type,
  });
  return jobName;
}
