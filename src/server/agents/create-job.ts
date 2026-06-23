import type { AwsCredentials } from "~/server/agents/aws";
import { env } from "~/env";
import { ingestToken } from "~/lib/ingest";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import {
  getBatchV1Api,
  getCoreV1Api,
  getNetworkingV1Api,
} from "~/server/k8s/client";

/** Seconds a finished Job (and its pod) is retained before Kubernetes deletes it. */
export const JOB_TTL_SECONDS = 7 * 24 * 3600; // one week

/** Default cap on Claude agentic turns when the deploy form leaves it blank. */
export const DEFAULT_MAX_TURNS = 100;

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

/**
 * Per-repo loosenings of the default agent egress rules, applied to the
 * namespace's NetworkPolicy. Both default off (the locked-down baseline); each
 * widens what agent pods can reach. See `repoWebhookConfig` and the repo-config
 * UI's security warning.
 */
export interface NetworkPolicyOptions {
  /**
   * Allow egress to private / in-cluster (RFC-1918) ranges by dropping the
   * AGENT_EGRESS_BLOCKED_CIDRS exclusion. Lets agents reach other pods and
   * in-cluster services (lateral-movement risk).
   */
  allowPrivateEgress?: boolean;
  /**
   * Allow egress on any TCP port instead of only 80/443. Widens the
   * exfiltration / arbitrary-protocol surface.
   */
  allowAllPortsEgress?: boolean;
}

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
 * port restriction. Both default off, preserving the locked-down baseline. The
 * policy is re-applied on every deploy (create, else replace) so flipping a
 * toggle takes effect on an existing namespace's next run rather than being
 * pinned to whatever it was first created with.
 */
/** Name of the per-namespace NetworkPolicy that isolates agent pods. */
export const NETWORK_POLICY_NAME = "bandolier-agent-isolation";

/**
 * Builds the agent-isolation NetworkPolicy body for a namespace, applying the
 * per-repo egress toggles to the default rules. Pure (no cluster access) so the
 * toggle logic is unit-testable. `blockedCidrs` is the configured in-cluster
 * block list (from AGENT_EGRESS_BLOCKED_CIDRS), dropped when private egress is
 * allowed.
 */
export function buildNetworkPolicyBody(
  namespace: string,
  blockedCidrs: string[],
  opts?: NetworkPolicyOptions,
): object {
  // `allowPrivateEgress` drops the in-cluster CIDR block; otherwise the
  // configured private ranges stay unreachable.
  const blocked = opts?.allowPrivateEgress ? [] : blockedCidrs;

  // `allowAllPortsEgress` lifts the 80/443 restriction (omitting `ports`
  // altogether means every port); otherwise only HTTP(S) is allowed out.
  const internetPorts = opts?.allowAllPortsEgress
    ? undefined
    : [
        { protocol: "TCP" as const, port: 443 },
        { protocol: "TCP" as const, port: 80 },
      ];

  const ipBlock =
    blocked.length > 0
      ? { cidr: "0.0.0.0/0", except: blocked }
      : { cidr: "0.0.0.0/0" };

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: NETWORK_POLICY_NAME,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "bandolier" },
    },
    spec: {
      podSelector: { matchLabels: { app: "bandolier-agent" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [], // deny all inbound
      egress: [
        {
          // DNS resolution via kube-dns.
          to: [
            {
              namespaceSelector: {},
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          // Public internet (and, when allowed, in-cluster ranges), restricted
          // to HTTP(S) unless all ports are permitted.
          to: [{ ipBlock }],
          ...(internetPorts && { ports: internetPorts }),
        },
      ],
    },
  };
}

async function ensureNetworkPolicy(
  namespace: string,
  kubeconfig: string,
  opts?: NetworkPolicyOptions,
): Promise<void> {
  if (env.AGENT_NETWORK_POLICY !== "true") return;

  const blockedCidrs = env.AGENT_EGRESS_BLOCKED_CIDRS.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const body = buildNetworkPolicyBody(namespace, blockedCidrs, opts);

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

type EnvVar = { name: string; value?: string; valueFrom?: object };

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
   * What the run produces when it finishes: a pull request (default) or a GitHub
   * issue. In issue mode the harness runs the agent read-only and opens one issue
   * written from the transcript — for a webhook/issue-triggered run, a sub-task of
   * the originating issue. Issue mode requires `repoFullName` (where to open it).
   */
  outputType?: "pr" | "issue";
  gitName?: string;
  gitEmail?: string;
  /** Set for issue tasks (dashboard or webhook). */
  issueNumber?: string;
  /** Link to the originating GitHub issue (issue tasks). */
  issueUrl?: string;
  /** The (unique) working branch the harness should use, referenced in the prompt. */
  agentBranch?: string;
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
   * The acting user's OpenAI API key. Used when an OpenAI model is selected; the
   * harness runs these through the OpenAI Codex CLI.
   */
  openaiApiKey?: string;
  /**
   * The acting user's Google Cloud project credentials JSON (service-account key
   * or ADC). Used when a Gemini model is selected; the harness runs these through
   * the Antigravity CLI (agy), which authenticates against the project via
   * Application Default Credentials. Injected as GOOGLE_PROJECT_CREDENTIALS and
   * written to ~/.gemini/credentials.json in the harness.
   */
  geminiApiKey?: string;
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
   * Per-repo loosenings of the agent NetworkPolicy egress rules (admin-set in
   * repo config). Both default off, preserving the locked-down baseline; each
   * widens what this run's pod can reach. Applied to the namespace's policy
   * before the Job is created. Unset = the default isolated egress.
   */
  networkPolicy?: NetworkPolicyOptions;
}

/** Per-job secret holding the acting user's credentials (GitHub / AWS / Anthropic). */
function userSecretName(jobName: string): string {
  return `${jobName}-creds`;
}

/** Per-job image-pull secret (dockerconfigjson) for a private agent image. */
function pullSecretName(jobName: string): string {
  return `${jobName}-pull`;
}

export async function createAgentJob(spec: JobSpec): Promise<string> {
  const ns = spec.namespace ?? DEFAULT_NAMESPACE;
  const jobName = `bandolier-agent-${Date.now()}`;

  const useUserAws = !!spec.awsCredentials;
  // Anthropic only applies when AWS isn't set (AWS Bedrock takes precedence).
  const useUserAnthropic = !useUserAws && !!spec.anthropicApiKey;
  // OpenAI / Gemini are lower precedence — used only when no Claude provider is.
  const useUserOpenai = !useUserAws && !useUserAnthropic && !!spec.openaiApiKey;
  const useUserGemini =
    !useUserAws && !useUserAnthropic && !useUserOpenai && !!spec.geminiApiKey;
  const useUserToken = !!spec.githubToken;

  // Only user-provided credentials are ever used — there is no server fallback.
  if (!useUserAws && !useUserAnthropic && !useUserOpenai && !useUserGemini) {
    throw new Error(
      "No model credentials available. Configure AWS, Anthropic, OpenAI, or Gemini credentials in account settings.",
    );
  }

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

  // The model id is chosen by the user from their provider's live model list.
  const provider = useUserAws
    ? { type: "bedrock" as const, model: spec.model }
    : useUserAnthropic
      ? { type: "anthropic" as const, model: spec.model }
      : useUserOpenai
        ? { type: "openai" as const, model: spec.model }
        : { type: "gemini" as const, model: spec.model };
  console.log("[bandolier:deploy] provider", {
    type: provider.type,
    model: provider.model,
  });

  // All credentials come from the per-job secret created below.
  const userRef = (key: string, optional = false): EnvVar => ({
    name: key,
    valueFrom: {
      secretKeyRef: { name: userSecretName(jobName), key, optional },
    },
  });

  const providerEnvVars: EnvVar[] = useUserAws
    ? [
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
        { name: "AWS_REGION", value: spec.awsCredentials!.region },
        userRef("AWS_ACCESS_KEY_ID"),
        userRef("AWS_SECRET_ACCESS_KEY"),
        userRef("AWS_SESSION_TOKEN", true),
      ]
    : useUserAnthropic
      ? [userRef("ANTHROPIC_API_KEY")]
      : useUserOpenai
        ? [userRef("OPENAI_API_KEY")]
        : [userRef("GOOGLE_PROJECT_CREDENTIALS")];

  const envVars: EnvVar[] = [
    { name: "CLAUDE_TASK", value: spec.task },
    { name: "CLAUDE_MODEL", value: provider.model },
    { name: "AGENT_TITLE", value: spec.displayName },
    { name: "REPO_URL", value: spec.repoUrl ?? "" },
    { name: "BRANCH", value: spec.branch },
    { name: "GIT_NAME", value: spec.gitName ?? "Bandolier Agent" },
    {
      name: "GIT_EMAIL",
      value: spec.gitEmail ?? "bandolier-agent@bandolier.local",
    },
    ...providerEnvVars,
    userRef("GITHUB_TOKEN", true),
  ];

  // Always cap turns so an agent can't run away; the form value overrides it.
  envVars.push({
    name: "MAX_TURNS",
    value: String(spec.maxTurns ?? DEFAULT_MAX_TURNS),
  });
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

  // Annotations carried on both the Job and the pod (the dashboard reads pods).
  // The repo is an annotation (it contains "/", invalid in a label) and is used
  // by the overview to show which repository an agent belongs to.
  const annotations: Record<string, string> = {
    "bandolier.io/display-name": spec.displayName,
    ...(spec.repoFullName && { "bandolier.io/repo": spec.repoFullName }),
    ...(spec.issueNumber && { "bandolier.io/github-issue": spec.issueNumber }),
    ...(spec.issueUrl && { "bandolier.io/issue-url": spec.issueUrl }),
    ...(spec.outputType === "issue" && {
      "bandolier.io/output-type": "issue",
    }),
    ...(spec.createdBy && { "bandolier.io/created-by": spec.createdBy }),
  };

  // Scopes the cross-repo overview to the user who spawned the agent (queried via
  // a label selector, so no cluster-wide pod scan is needed).
  const spawnedBy = spawnedByLabelValue(spec.userId);

  // Marks interactive agents so the dashboard can surface them separately (a
  // label, not an annotation, so it's queryable and visible on every pod).
  const interactiveLabels: Record<string, string> = spec.interactive
    ? { "bandolier.io/interactive": "true" }
    : {};

  const job = await getBatchV1Api(kc).createNamespacedJob({
    namespace: ns,
    body: {
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
                resources: {
                  requests: { cpu: "500m", memory: "512Mi" },
                  limits: { cpu: "2", memory: "2Gi" },
                },
                volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              },
            ],
            volumes: [{ name: "workspace", emptyDir: {} }],
          },
        },
      },
    },
  });

  // Store the acting user's credentials in a per-job secret owned by the Job, so
  // they're garbage-collected when the Job is deleted (manually or via TTL).
  const stringData: Record<string, string> = {};
  if (useUserToken) stringData.GITHUB_TOKEN = spec.githubToken!;
  if (useUserAnthropic) stringData.ANTHROPIC_API_KEY = spec.anthropicApiKey!;
  if (useUserOpenai) stringData.OPENAI_API_KEY = spec.openaiApiKey!;
  // agy (Antigravity CLI) authenticates via Application Default Credentials; the
  // harness writes this project credentials JSON to ~/.gemini/credentials.json.
  if (useUserGemini) stringData.GOOGLE_PROJECT_CREDENTIALS = spec.geminiApiKey!;
  if (useUserAws) {
    stringData.AWS_ACCESS_KEY_ID = spec.awsCredentials!.accessKeyId;
    stringData.AWS_SECRET_ACCESS_KEY = spec.awsCredentials!.secretAccessKey;
    // Only include a session token for temporary credentials; an empty value
    // would break SigV4 for permanent IAM keys.
    if (spec.awsCredentials!.sessionToken) {
      stringData.AWS_SESSION_TOKEN = spec.awsCredentials!.sessionToken;
    }
  }

  // Owner reference tying a secret's lifecycle to the Job, so Kubernetes
  // garbage-collects it when the Job is deleted (manually or via TTL).
  const jobOwnerRef = {
    apiVersion: "batch/v1",
    kind: "Job",
    name: jobName,
    uid: job.metadata?.uid ?? "",
    blockOwnerDeletion: true,
  };

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

  // Record the run so it can be listed/inspected after the Job's TTL deletes the
  // pod. Inserted for every run, not just when S3 is configured: the harness
  // reports the run's structured output (PR/issue URL) into this row via the
  // ingest callback, and that output must outlive the pod logs regardless of
  // whether transcript artifacts are also being stored. The transcriptKey column
  // stays null when there's no bucket to upload to.
  await db.insert(taskRun).values({
    jobName,
    namespace: ns,
    displayName: spec.displayName,
    createdBy: spec.createdBy ?? null,
    repoFullName: spec.repoFullName ?? null,
    issueNumber: spec.issueNumber ?? null,
  });

  console.log("[bandolier:deploy] job created", {
    job: jobName,
    namespace: ns,
    github: useUserToken,
    aws: useUserAws,
    anthropic: useUserAnthropic,
    openai: useUserOpenai,
    gemini: useUserGemini,
  });
  return jobName;
}
