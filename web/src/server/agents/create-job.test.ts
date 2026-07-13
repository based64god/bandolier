import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "~/server/agents/create-job";
import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import type { NetworkPolicyOptions } from "~/server/agents/network-policy";

// createAgentJob is a manifest builder: mock every external boundary it
// touches — the Kubernetes APIs, the database, the env, the ingest-token
// derivation, and the network-policy builders — and assert on the manifests
// and rows it constructs. The labels helper stays real (pure hashing).

// ── Assertion-side views of the manifests sent to the mocked cluster ─────────

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef: { name: string; key: string; optional: boolean };
  };
};

interface JobCall {
  namespace: string;
  body: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
    };
    spec: {
      ttlSecondsAfterFinished: number;
      backoffLimit: number;
      template: {
        metadata: {
          labels: Record<string, string>;
          annotations: Record<string, string>;
        };
        spec: {
          serviceAccountName: string;
          restartPolicy: string;
          imagePullSecrets?: { name: string }[];
          securityContext: {
            runAsUser: number;
            runAsGroup: number;
            fsGroup: number;
          };
          containers: {
            name: string;
            image: string;
            env: EnvVar[];
            resources: {
              requests: { cpu: string; memory: string };
              limits: { cpu: string; memory: string };
            };
          }[];
        };
      };
    };
  };
}

interface SecretCall {
  namespace: string;
  body: {
    metadata: {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      ownerReferences: {
        apiVersion: string;
        kind: string;
        name: string;
        uid: string;
        blockOwnerDeletion: boolean;
      }[];
    };
    type: string;
    stringData: Record<string, string>;
  };
}

interface PdbCall {
  namespace: string;
  body: {
    metadata: {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      ownerReferences: {
        apiVersion: string;
        kind: string;
        name: string;
        uid: string;
        blockOwnerDeletion: boolean;
      }[];
    };
    spec: {
      minAvailable: number;
      selector: { matchLabels: Record<string, string> };
    };
  };
}

interface ServiceAccountCall {
  namespace: string;
  body: {
    metadata: {
      name: string;
      namespace: string;
      labels: Record<string, string>;
    };
    automountServiceAccountToken: boolean;
  };
}

// ── Mocked boundaries ─────────────────────────────────────────────────────────

const createNamespace =
  vi.fn<
    (call: {
      body: { metadata: { name: string; labels: Record<string, string> } };
    }) => Promise<object>
  >();
const createNamespacedServiceAccount =
  vi.fn<(call: ServiceAccountCall) => Promise<object>>();
const createNamespacedSecret = vi.fn<(call: SecretCall) => Promise<object>>();
const createNamespacedJob =
  vi.fn<(call: JobCall) => Promise<{ metadata?: { uid?: string } }>>();
const createNamespacedNetworkPolicy =
  vi.fn<(call: { namespace: string; body: object }) => Promise<object>>();
const createNamespacedPodDisruptionBudget =
  vi.fn<(call: PdbCall) => Promise<object>>();
const replaceNamespacedNetworkPolicy =
  vi.fn<
    (call: { name: string; namespace: string; body: object }) => Promise<object>
  >();

const getCoreV1Api = vi.fn((_kc: string) => ({
  createNamespace,
  createNamespacedServiceAccount,
  createNamespacedSecret,
}));
const getBatchV1Api = vi.fn((_kc: string) => ({ createNamespacedJob }));
const getNetworkingV1Api = vi.fn((_kc: string) => ({
  createNamespacedNetworkPolicy,
  replaceNamespacedNetworkPolicy,
}));
const getPolicyV1Api = vi.fn((_kc: string) => ({
  createNamespacedPodDisruptionBudget,
}));

vi.mock("~/server/k8s/client", () => ({
  getCoreV1Api: (kc: string) => getCoreV1Api(kc),
  getBatchV1Api: (kc: string) => getBatchV1Api(kc),
  getNetworkingV1Api: (kc: string) => getNetworkingV1Api(kc),
  getPolicyV1Api: (kc: string) => getPolicyV1Api(kc),
}));

interface TaskRunInsertValues {
  jobName: string;
  namespace: string;
  displayName: string;
  createdBy: string | null;
  spawnedBy: string;
  repoFullName: string | null;
  issueNumber: string | null;
  parentJobName: string | null;
}
const insertValues = vi.fn<(values: TaskRunInsertValues) => Promise<void>>();
const dbInsert = vi.fn((_table: unknown) => ({ values: insertValues }));
vi.mock("~/server/db", () => ({
  db: { insert: (table: unknown) => dbInsert(table) },
}));

// Mutable env read by the module at call time; tests flip AGENT_NETWORK_POLICY.
const mockEnv = {
  AGENT_NETWORK_POLICY: "false",
  BETTER_AUTH_URL: "http://test.local",
  BETTER_AUTH_SECRET: "test-secret",
};
vi.mock("~/env", () => ({ env: mockEnv }));

const ingestToken = vi.fn(
  (_job: string, _secret: string | undefined) => "tok-123",
);
vi.mock("~/lib/ingest", () => ({
  ingestToken: (job: string, secret: string | undefined) =>
    ingestToken(job, secret),
}));

// Sentinel bodies let tests assert which builder produced the applied policy.
const DEFAULT_POLICY_BODY = { sentinel: "default-policy" };
const CUSTOM_POLICY_BODY = { sentinel: "custom-policy" };
const buildNetworkPolicyBody = vi.fn(
  (_ns: string, _cidrs: string[], _opts?: NetworkPolicyOptions) =>
    DEFAULT_POLICY_BODY,
);
const buildCustomNetworkPolicyBody = vi.fn(
  (_ns: string, _yaml: string) => CUSTOM_POLICY_BODY,
);
vi.mock("~/server/agents/network-policy", () => ({
  NETWORK_POLICY_NAME: "bandolier-agent-isolation",
  agentEgressBlockedCidrs: () => ["10.0.0.0/8"],
  buildNetworkPolicyBody: (
    ns: string,
    cidrs: string[],
    opts?: NetworkPolicyOptions,
  ) => buildNetworkPolicyBody(ns, cidrs, opts),
  buildCustomNetworkPolicyBody: (ns: string, yaml: string) =>
    buildCustomNetworkPolicyBody(ns, yaml),
}));

const {
  createAgentJob,
  resolveProvider,
  buildEnvVars,
  ensureNamespace,
  ensureServiceAccount,
  podResources,
  DEFAULT_HARNESS_IMAGE,
  DEFAULT_MAX_TURNS,
  JOB_TTL_SECONDS,
} = await import("~/server/agents/create-job");

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    task: "do the thing",
    displayName: "Do the thing",
    branch: "main",
    model: "claude-test-1",
    userId: "u1",
    kubeconfig: "kc-yaml",
    anthropicApiKey: "sk-a",
    ...overrides,
  };
}

function jobCall(): JobCall {
  expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  return createNamespacedJob.mock.calls[0]![0];
}

function jobEnv(): EnvVar[] {
  return jobCall().body.spec.template.spec.containers[0]!.env;
}

function envVar(name: string): EnvVar | undefined {
  return jobEnv().find((e) => e.name === name);
}

function envNames(): string[] {
  return jobEnv().map((e) => e.name);
}

/** The per-job creds secret is always the first secret created. */
function credsSecret(): SecretCall {
  return createNamespacedSecret.mock.calls[0]![0];
}

/** The expected shape of a `userRef` env var into the per-job creds secret. */
function secretRef(jobName: string, key: string, optional = false): EnvVar {
  return {
    name: key,
    valueFrom: { secretKeyRef: { name: `${jobName}-creds`, key, optional } },
  };
}

const conflict = () => Object.assign(new Error("conflict"), { code: 409 });

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.AGENT_NETWORK_POLICY = "false";
  createNamespace.mockResolvedValue({});
  createNamespacedServiceAccount.mockResolvedValue({});
  createNamespacedSecret.mockResolvedValue({});
  createNamespacedJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
  createNamespacedNetworkPolicy.mockResolvedValue({});
  replaceNamespacedNetworkPolicy.mockResolvedValue({});
  createNamespacedPodDisruptionBudget.mockResolvedValue({});
  insertValues.mockResolvedValue(undefined);
  ingestToken.mockReturnValue("tok-123");
});

// ── createAgentJob ────────────────────────────────────────────────────────────

describe("createAgentJob", () => {
  it("rejects when no model credentials are configured", async () => {
    await expect(
      createAgentJob(baseSpec({ anthropicApiKey: undefined })),
    ).rejects.toThrow(/No model credentials available/);
    expect(createNamespacedJob).not.toHaveBeenCalled();
  });

  it("rejects when the spec carries no kubeconfig", async () => {
    await expect(createAgentJob(baseSpec({ kubeconfig: "" }))).rejects.toThrow(
      /No kubeconfig available/,
    );
    expect(createNamespacedJob).not.toHaveBeenCalled();
  });

  it("names the job bandolier-agent-<timestamp> and threads it through the manifests", async () => {
    const jobName = await createAgentJob(baseSpec());
    expect(jobName).toMatch(/^bandolier-agent-\d+$/);
    const call = jobCall();
    // No namespace on the spec → the safety default.
    expect(call.namespace).toBe("bandolier-agents");
    expect(call.body.metadata.name).toBe(jobName);
    expect(call.body.spec.template.metadata.labels["bandolier.io/job"]).toBe(
      jobName,
    );
    expect(credsSecret().body.metadata.name).toBe(`${jobName}-creds`);
    // Every API client is built from the spec's kubeconfig.
    expect(getBatchV1Api).toHaveBeenCalledWith("kc-yaml");
    expect(getCoreV1Api).toHaveBeenCalledWith("kc-yaml");
  });

  describe("provider credentials", () => {
    const aws = {
      accessKeyId: "AKIA1",
      secretAccessKey: "aws-secret",
      sessionToken: "sess-tok",
      region: "us-east-1",
    };

    it("prefers AWS Bedrock over Anthropic and wires the Bedrock env trio", async () => {
      const jobName = await createAgentJob(baseSpec({ awsCredentials: aws }));
      const env = jobEnv();
      expect(env).toContainEqual({
        name: "CLAUDE_CODE_USE_BEDROCK",
        value: "1",
      });
      expect(env).toContainEqual({ name: "AWS_REGION", value: "us-east-1" });
      expect(env).toContainEqual(secretRef(jobName, "AWS_ACCESS_KEY_ID"));
      expect(env).toContainEqual(secretRef(jobName, "AWS_SECRET_ACCESS_KEY"));
      // The session token is optional — permanent IAM keys don't have one.
      expect(env).toContainEqual(secretRef(jobName, "AWS_SESSION_TOKEN", true));
      expect(envNames()).not.toContain("ANTHROPIC_API_KEY");
      // The secret carries only the winning provider's credentials.
      expect(credsSecret().body.stringData).toEqual({
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        AWS_SESSION_TOKEN: "sess-tok",
      });
    });

    it("omits AWS_SESSION_TOKEN from the secret for permanent credentials", async () => {
      await createAgentJob(
        baseSpec({ awsCredentials: { ...aws, sessionToken: null } }),
      );
      expect(credsSecret().body.stringData).not.toHaveProperty(
        "AWS_SESSION_TOKEN",
      );
    });

    it("wires ANTHROPIC_API_KEY for an API-key spec", async () => {
      const jobName = await createAgentJob(baseSpec());
      expect(jobEnv()).toContainEqual(secretRef(jobName, "ANTHROPIC_API_KEY"));
      expect(credsSecret().body.stringData).toEqual({
        ANTHROPIC_API_KEY: "sk-a",
      });
    });

    it("wires CLAUDE_CODE_OAUTH_TOKEN for a subscription-token spec", async () => {
      const jobName = await createAgentJob(
        baseSpec({ anthropicApiKey: undefined, anthropicOauthToken: "oat-1" }),
      );
      expect(jobEnv()).toContainEqual(
        secretRef(jobName, "CLAUDE_CODE_OAUTH_TOKEN"),
      );
      expect(credsSecret().body.stringData).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: "oat-1",
      });
    });

    it("prefers the API key when both Anthropic credentials are set", async () => {
      const jobName = await createAgentJob(
        baseSpec({ anthropicOauthToken: "oat-1" }),
      );
      expect(jobEnv()).toContainEqual(secretRef(jobName, "ANTHROPIC_API_KEY"));
      expect(envNames()).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      // Exactly one Anthropic credential lands in the secret.
      expect(credsSecret().body.stringData).toEqual({
        ANTHROPIC_API_KEY: "sk-a",
      });
    });

    it("routes an OpenAI key through the openai proxy backend", async () => {
      const jobName = await createAgentJob(
        baseSpec({ anthropicApiKey: undefined, openaiApiKey: "sk-o" }),
      );
      // Proxied like every non-native provider: the backend id rides as a plain
      // env var and the key lands in the per-job secret.
      expect(jobEnv()).toContainEqual({
        name: "BANDOLIER_LLM_PROVIDER",
        value: "openai",
      });
      expect(jobEnv()).toContainEqual(secretRef(jobName, "OPENAI_API_KEY"));
      expect(credsSecret().body.stringData).toEqual({ OPENAI_API_KEY: "sk-o" });
    });

    it("routes ChatGPT-subscription auth through the chatgpt proxy backend", async () => {
      const jobName = await createAgentJob(
        baseSpec({
          anthropicApiKey: undefined,
          codexAuthJson: '{"tokens":{}}',
        }),
      );
      expect(jobEnv()).toContainEqual({
        name: "BANDOLIER_LLM_PROVIDER",
        value: "chatgpt",
      });
      expect(jobEnv()).toContainEqual(secretRef(jobName, "CODEX_AUTH_JSON"));
      expect(credsSecret().body.stringData).toEqual({
        CODEX_AUTH_JSON: '{"tokens":{}}',
      });
    });

    it("routes Gemini through the vertex proxy backend with inline credentials", async () => {
      const jobName = await createAgentJob(
        baseSpec({ anthropicApiKey: undefined, geminiApiKey: '{"project":1}' }),
      );
      expect(jobEnv()).toContainEqual({
        name: "BANDOLIER_LLM_PROVIDER",
        value: "vertex",
      });
      // The service-account JSON is injected inline (no file); gollm's vertex
      // backend reads it from GOOGLE_APPLICATION_CREDENTIALS_JSON.
      expect(jobEnv()).toContainEqual(
        secretRef(jobName, "GOOGLE_APPLICATION_CREDENTIALS_JSON"),
      );
      expect(credsSecret().body.stringData).toEqual({
        GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"project":1}',
      });
    });

    it("wires a gollm-proxied provider's id and env for a custom-provider spec", async () => {
      const jobName = await createAgentJob(
        baseSpec({
          anthropicApiKey: undefined,
          customProvider: {
            provider: "openrouter",
            env: { OPENROUTER_API_KEY: "sk-or", OPENAI_LIKE_API_BASE: "" },
          },
        }),
      );
      // The provider id rides as a plain env var the harness routes the proxy by.
      expect(jobEnv()).toContainEqual({
        name: "BANDOLIER_LLM_PROVIDER",
        value: "openrouter",
      });
      // Every credential env var becomes a secret ref, and the secret carries
      // exactly that provider's values.
      expect(jobEnv()).toContainEqual(secretRef(jobName, "OPENROUTER_API_KEY"));
      expect(credsSecret().body.stringData).toEqual({
        OPENROUTER_API_KEY: "sk-or",
        OPENAI_LIKE_API_BASE: "",
      });
      expect(envNames()).not.toContain("ANTHROPIC_API_KEY");
    });

    it("stores the GitHub token in the secret when given", async () => {
      const jobName = await createAgentJob(baseSpec({ githubToken: "gh-tok" }));
      expect(credsSecret().body.stringData.GITHUB_TOKEN).toBe("gh-tok");
      // The env ref is optional so tokenless runs use the same manifest shape.
      expect(jobEnv()).toContainEqual(secretRef(jobName, "GITHUB_TOKEN", true));
    });

    it("keeps GITHUB_TOKEN out of the secret when no token is given", async () => {
      const jobName = await createAgentJob(baseSpec());
      expect(credsSecret().body.stringData).not.toHaveProperty("GITHUB_TOKEN");
      expect(jobEnv()).toContainEqual(secretRef(jobName, "GITHUB_TOKEN", true));
    });
  });

  describe("env vars", () => {
    it("defaults to unlimited turns when the spec leaves maxTurns blank", async () => {
      await createAgentJob(baseSpec());
      expect(envVar("MAX_TURNS")?.value).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it("uses the spec's maxTurns when set", async () => {
      await createAgentJob(baseSpec({ maxTurns: 7 }));
      expect(envVar("MAX_TURNS")?.value).toBe("7");
    });

    it("forwards effort for a Claude provider", async () => {
      await createAgentJob(baseSpec({ effort: "high" }));
      expect(envVar("CLAUDE_EFFORT")?.value).toBe("high");
    });

    it("forwards effort for a proxy-routed provider too", async () => {
      await createAgentJob(
        baseSpec({
          anthropicApiKey: undefined,
          openaiApiKey: "sk-o",
          effort: "high",
        }),
      );
      expect(envVar("CLAUDE_EFFORT")?.value).toBe("high");
    });

    it("always wires the ingest callback; feature URLs stay off a minimal spec", async () => {
      const jobName = await createAgentJob(baseSpec());
      expect(envVar("BANDOLIER_JOB")?.value).toBe(jobName);
      expect(envVar("BANDOLIER_INGEST_TOKEN")?.value).toBe("tok-123");
      expect(ingestToken).toHaveBeenCalledWith(jobName, "test-secret");
      expect(envVar("BANDOLIER_INGEST_URL")?.value).toBe(
        "http://test.local/api/agent-runs",
      );
      for (const name of [
        "BANDOLIER_CONTEXT_URL",
        "INTERACTIVE",
        "BANDOLIER_INPUT_URL",
        "BANDOLIER_ACP_URL",
        "PR_WRITER_MODEL",
        "GITHUB_ISSUE_NUMBER",
        "OUTPUT_TYPE",
      ]) {
        expect(envNames()).not.toContain(name);
      }
    });

    it("adds the parent-context URL and lineage annotations for a resumed run", async () => {
      await createAgentJob(
        baseSpec({
          parentJobName: "bandolier-agent-1",
          parentDisplayName: "Parent run",
        }),
      );
      expect(envVar("BANDOLIER_CONTEXT_URL")?.value).toBe(
        "http://test.local/api/agent-runs",
      );
      const body = jobCall().body;
      expect(body.metadata.annotations["bandolier.io/parent-job"]).toBe(
        "bandolier-agent-1",
      );
      expect(body.metadata.annotations["bandolier.io/parent-name"]).toBe(
        "Parent run",
      );
      // The pod carries the same lineage (the dashboard reads pods).
      expect(
        body.spec.template.metadata.annotations["bandolier.io/parent-job"],
      ).toBe("bandolier-agent-1");
    });

    it("marks interactive runs with env vars and a queryable label", async () => {
      await createAgentJob(baseSpec({ interactive: true }));
      expect(envVar("INTERACTIVE")?.value).toBe("1");
      expect(envVar("BANDOLIER_INPUT_URL")?.value).toBe(
        "http://test.local/api/agent-input",
      );
      expect(envVar("BANDOLIER_ACP_URL")?.value).toBe(
        "http://test.local/api/acp",
      );
      const body = jobCall().body;
      expect(body.metadata.labels["bandolier.io/interactive"]).toBe("true");
      expect(
        body.spec.template.metadata.labels["bandolier.io/interactive"],
      ).toBe("true");
    });

    it("maps every optional spec field to its env var", async () => {
      await createAgentJob(
        baseSpec({
          prWriterModel: "sonnet-latest",
          issueNumber: "42",
          repoFullName: "owner/repo",
          agentBranch: "agent/run-1",
          baseBranch: "develop",
          resumeBranch: "agent/old",
          systemPrompt: "sys prompt",
          repoSystemPrompt: "repo prompt",
          outputType: "issue",
        }),
      );
      expect(envVar("PR_WRITER_MODEL")?.value).toBe("sonnet-latest");
      expect(envVar("GITHUB_ISSUE_NUMBER")?.value).toBe("42");
      expect(envVar("GITHUB_REPO")?.value).toBe("owner/repo");
      expect(envVar("AGENT_BRANCH")?.value).toBe("agent/run-1");
      expect(envVar("GITHUB_BASE_BRANCH")?.value).toBe("develop");
      expect(envVar("RESUME_BRANCH")?.value).toBe("agent/old");
      expect(envVar("CLAUDE_SYSTEM_PROMPT")?.value).toBe("sys prompt");
      expect(envVar("REPO_SYSTEM_PROMPT")?.value).toBe("repo prompt");
      expect(envVar("OUTPUT_TYPE")?.value).toBe("issue");
    });
  });

  describe("annotations and labels", () => {
    it("carries only the display-name annotation and dashboard source on a minimal spec", async () => {
      await createAgentJob(baseSpec());
      const body = jobCall().body;
      expect(body.metadata.annotations).toEqual({
        "bandolier.io/display-name": "Do the thing",
      });
      expect(body.spec.template.metadata.annotations).toEqual({
        "bandolier.io/display-name": "Do the thing",
      });
      expect(body.spec.template.metadata.labels["bandolier.io/source"]).toBe(
        "dashboard",
      );
      // No interactive label unless the run is interactive.
      expect(body.metadata.labels).not.toHaveProperty(
        "bandolier.io/interactive",
      );
    });

    it("annotates repo/issue/creator/output-type details on the Job and pod", async () => {
      await createAgentJob(
        baseSpec({
          repoFullName: "owner/repo",
          issueNumber: "42",
          issueUrl: "https://github.com/owner/repo/issues/42",
          createdBy: "someone@example.com",
          outputType: "issue",
        }),
      );
      const body = jobCall().body;
      const expected = {
        "bandolier.io/display-name": "Do the thing",
        "bandolier.io/repo": "owner/repo",
        "bandolier.io/github-issue": "42",
        "bandolier.io/issue-url": "https://github.com/owner/repo/issues/42",
        "bandolier.io/output-type": "issue",
        "bandolier.io/created-by": "someone@example.com",
      };
      expect(body.metadata.annotations).toEqual(expected);
      expect(body.spec.template.metadata.annotations).toEqual(expected);
      // Issue-triggered runs are labelled as such on the pod.
      expect(body.spec.template.metadata.labels["bandolier.io/source"]).toBe(
        "github-issue",
      );
    });

    it("labels the job with a label-safe user id verbatim", async () => {
      await createAgentJob(baseSpec());
      const body = jobCall().body;
      expect(body.metadata.labels[SPAWNED_BY_LABEL]).toBe("u1");
      expect(body.spec.template.metadata.labels[SPAWNED_BY_LABEL]).toBe("u1");
    });

    it("hashes a label-unsafe user id for the label but records the raw id in the DB", async () => {
      const userId = "user with spaces!";
      await createAgentJob(baseSpec({ userId }));
      const expected = spawnedByLabelValue(userId);
      expect(expected).toMatch(/^[0-9a-f]{63}$/);
      const body = jobCall().body;
      expect(body.metadata.labels[SPAWNED_BY_LABEL]).toBe(expected);
      expect(body.spec.template.metadata.labels[SPAWNED_BY_LABEL]).toBe(
        expected,
      );
      // The run row keeps the canonical id for ownership checks.
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ spawnedBy: userId }),
      );
    });
  });

  describe("job body", () => {
    it("builds the job with the TTL, no retries, root user, and the default image", async () => {
      await createAgentJob(baseSpec());
      const body = jobCall().body;
      expect(body.spec.ttlSecondsAfterFinished).toBe(JOB_TTL_SECONDS);
      expect(body.spec.backoffLimit).toBe(0);
      const pod = body.spec.template.spec;
      expect(pod.serviceAccountName).toBe("bandolier-agent");
      expect(pod.restartPolicy).toBe("Never");
      expect(pod.securityContext.runAsUser).toBe(0);
      expect(pod.containers[0]!.image).toBe(DEFAULT_HARNESS_IMAGE);
      // Public images need no pull secret — the key is omitted entirely.
      expect(pod).not.toHaveProperty("imagePullSecrets");
    });

    it("uses the repo's custom agent image when configured", async () => {
      await createAgentJob(baseSpec({ agentImage: "ghcr.io/acme/harness:1" }));
      expect(jobCall().body.spec.template.spec.containers[0]!.image).toBe(
        "ghcr.io/acme/harness:1",
      );
      // The run row records the same image, so the harness contract version
      // the run later reports is attributable to it.
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ agentImage: "ghcr.io/acme/harness:1" }),
      );
    });

    it("records the default image on the run row when no override is set", async () => {
      await createAgentJob(baseSpec());
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ agentImage: DEFAULT_HARNESS_IMAGE }),
      );
    });

    it("applies the built-in resource limits when the spec carries no compute", async () => {
      await createAgentJob(baseSpec());
      expect(
        jobCall().body.spec.template.spec.containers[0]!.resources,
      ).toEqual({
        requests: { cpu: "1000m", memory: "1024Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      });
    });

    it("applies the spec's compute as the pod's limits", async () => {
      await createAgentJob(baseSpec({ compute: { cpu: "4", memory: "8Gi" } }));
      expect(
        jobCall().body.spec.template.spec.containers[0]!.resources,
      ).toEqual({
        requests: { cpu: "2000m", memory: "4096Mi" },
        limits: { cpu: "4", memory: "8Gi" },
      });
    });

    it("rejects a malformed compute quantity instead of creating the job", async () => {
      await expect(
        createAgentJob(baseSpec({ compute: { memory: "lots" } })),
      ).rejects.toThrow(/Invalid memory quantity/);
      expect(createNamespacedJob).not.toHaveBeenCalled();
    });
  });

  describe("disruption budget", () => {
    it("pins the agent pod with a job-owned PDB so voluntary evictions are refused", async () => {
      const jobName = await createAgentJob(baseSpec());
      expect(createNamespacedPodDisruptionBudget).toHaveBeenCalledTimes(1);
      expect(getPolicyV1Api).toHaveBeenCalledWith("kc-yaml");
      const pdb = createNamespacedPodDisruptionBudget.mock.calls[0]![0];
      expect(pdb.namespace).toBe("bandolier-agents");
      expect(pdb.body.metadata.name).toBe(`${jobName}-pdb`);
      expect(pdb.body.metadata.ownerReferences).toEqual([
        {
          apiVersion: "batch/v1",
          kind: "Job",
          name: jobName,
          uid: "job-uid-1",
          blockOwnerDeletion: true,
        },
      ]);
      expect(pdb.body.spec).toEqual({
        minAvailable: 1,
        selector: { matchLabels: { "bandolier.io/job": jobName } },
      });
    });

    it("still deploys the run when PDB creation fails", async () => {
      createNamespacedPodDisruptionBudget.mockRejectedValue(
        Object.assign(new Error("forbidden"), { code: 403 }),
      );
      const jobName = await createAgentJob(baseSpec());
      expect(jobName).toMatch(/^bandolier-agent-\d+$/);
      // The creds secret and DB row are still created after the failed PDB.
      expect(credsSecret().body.metadata.name).toBe(`${jobName}-creds`);
      expect(insertValues).toHaveBeenCalledTimes(1);
    });
  });

  describe("podResources", () => {
    it("requests half of the configured limits", () => {
      expect(podResources({ cpu: "4", memory: "8Gi" })).toEqual({
        requests: { cpu: "2000m", memory: "4096Mi" },
        limits: { cpu: "4", memory: "8Gi" },
      });
    });

    it("halves small and odd limits into whole millicores / Mi", () => {
      expect(podResources({ cpu: "250m", memory: "255Mi" })).toEqual({
        requests: { cpu: "125m", memory: "128Mi" }, // 127.5Mi rounds up
        limits: { cpu: "250m", memory: "255Mi" },
      });
    });

    it("resolves each field independently, defaulting to the built-in limits", () => {
      expect(podResources({ memory: "16Gi" })).toEqual({
        requests: { cpu: "1000m", memory: "8192Mi" },
        limits: { cpu: "2", memory: "16Gi" },
      });
      expect(podResources()).toEqual({
        requests: { cpu: "1000m", memory: "1024Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      });
    });

    it("reads a bare memory number as Gi", () => {
      expect(podResources({ memory: "8" })).toEqual({
        requests: { cpu: "1000m", memory: "4096Mi" },
        limits: { cpu: "2", memory: "8Gi" },
      });
    });

    it("throws on out-of-bounds quantities", () => {
      expect(() => podResources({ cpu: "999" })).toThrow(/CPU must be/);
      expect(() => podResources({ memory: "2Ti" })).toThrow(/Memory must be/);
    });
  });

  describe("secrets", () => {
    it("ties the creds secret's lifecycle to the job", async () => {
      const jobName = await createAgentJob(baseSpec());
      const secret = credsSecret();
      expect(secret.body.type).toBe("Opaque");
      expect(secret.body.metadata.ownerReferences).toEqual([
        {
          apiVersion: "batch/v1",
          kind: "Job",
          name: jobName,
          uid: "job-uid-1",
          blockOwnerDeletion: true,
        },
      ]);
    });

    it("creates a dockerconfigjson pull secret owned by the job for a private image", async () => {
      const jobName = await createAgentJob(
        baseSpec({
          agentImage: "ghcr.io/acme/private:1",
          imagePullSecret: {
            registry: "ghcr.io",
            dockerConfigJson: '{"auths":{}}',
          },
        }),
      );
      expect(jobCall().body.spec.template.spec.imagePullSecrets).toEqual([
        { name: `${jobName}-pull` },
      ]);
      expect(createNamespacedSecret).toHaveBeenCalledTimes(2);
      const pull = createNamespacedSecret.mock.calls[1]![0];
      expect(pull.body.metadata.name).toBe(`${jobName}-pull`);
      expect(pull.body.type).toBe("kubernetes.io/dockerconfigjson");
      expect(pull.body.stringData).toEqual({
        ".dockerconfigjson": '{"auths":{}}',
      });
      expect(pull.body.metadata.ownerReferences[0]!.uid).toBe("job-uid-1");
    });

    it("creates only the creds secret for a public image", async () => {
      await createAgentJob(baseSpec());
      expect(createNamespacedSecret).toHaveBeenCalledTimes(1);
    });
  });

  describe("run row", () => {
    it("records the run with optional fields nulled", async () => {
      const jobName = await createAgentJob(baseSpec());
      expect(dbInsert).toHaveBeenCalledTimes(1);
      expect(insertValues).toHaveBeenCalledWith({
        jobName,
        namespace: "bandolier-agents",
        displayName: "Do the thing",
        createdBy: null,
        spawnedBy: "u1",
        repoFullName: null,
        issueNumber: null,
        parentJobName: null,
        ciResumeSha: null,
        agentImage: DEFAULT_HARNESS_IMAGE,
      });
    });

    it("deploys the job, secret, and row into the spec's namespace", async () => {
      await createAgentJob(baseSpec({ namespace: "custom-ns" }));
      const call = jobCall();
      expect(call.namespace).toBe("custom-ns");
      expect(call.body.metadata.namespace).toBe("custom-ns");
      expect(credsSecret().namespace).toBe("custom-ns");
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: "custom-ns" }),
      );
    });
  });
});

// ── resolveProvider ───────────────────────────────────────────────────────────

// The provider descriptor is the single source of truth for the per-provider
// credential mapping: env refs and secret payload both derive from it, so these
// unit tests pin the mapping directly without going through the whole monolith.

describe("resolveProvider", () => {
  const aws = {
    accessKeyId: "AKIA1",
    secretAccessKey: "aws-secret",
    sessionToken: "sess-tok",
    region: "us-east-1",
  };

  it("throws when the spec carries no model credentials", () => {
    expect(() =>
      resolveProvider(baseSpec({ anthropicApiKey: undefined })),
    ).toThrow(/No model credentials available/);
  });

  it("prefers AWS Bedrock over Anthropic", () => {
    const p = resolveProvider(baseSpec({ awsCredentials: aws }));
    expect(p.type).toBe("bedrock");
    expect(p.plainEnv).toContainEqual({
      name: "CLAUDE_CODE_USE_BEDROCK",
      value: "1",
    });
    expect(p.plainEnv).toContainEqual({
      name: "AWS_REGION",
      value: "us-east-1",
    });
    expect(p.secretRefs).toEqual([
      { key: "AWS_ACCESS_KEY_ID" },
      { key: "AWS_SECRET_ACCESS_KEY" },
      { key: "AWS_SESSION_TOKEN", optional: true },
    ]);
    expect(p.secretData).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA1",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "sess-tok",
    });
  });

  it("omits the AWS session token from the secret for permanent credentials", () => {
    const p = resolveProvider(
      baseSpec({ awsCredentials: { ...aws, sessionToken: null } }),
    );
    expect(p.secretData).not.toHaveProperty("AWS_SESSION_TOKEN");
    // The env ref stays present-but-optional so the manifest shape is stable.
    expect(p.secretRefs).toContainEqual({
      key: "AWS_SESSION_TOKEN",
      optional: true,
    });
  });

  it("maps an Anthropic API key to a single secret key", () => {
    const p = resolveProvider(baseSpec());
    expect(p.type).toBe("anthropic");
    expect(p.secretRefs).toEqual([{ key: "ANTHROPIC_API_KEY" }]);
    expect(p.secretData).toEqual({ ANTHROPIC_API_KEY: "sk-a" });
  });

  it("maps a subscription OAuth token when no API key is set", () => {
    const p = resolveProvider(
      baseSpec({ anthropicApiKey: undefined, anthropicOauthToken: "oat-1" }),
    );
    expect(p.secretRefs).toEqual([{ key: "CLAUDE_CODE_OAUTH_TOKEN" }]);
    expect(p.secretData).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oat-1" });
  });

  it("prefers the Anthropic API key over the OAuth token", () => {
    const p = resolveProvider(baseSpec({ anthropicOauthToken: "oat-1" }));
    expect(p.secretData).toEqual({ ANTHROPIC_API_KEY: "sk-a" });
  });

  it("routes OpenAI/Codex through the proxy (openai backend, key first)", () => {
    const key = resolveProvider(
      baseSpec({ anthropicApiKey: undefined, openaiApiKey: "sk-o" }),
    );
    expect(key.plainEnv).toContainEqual({
      name: "BANDOLIER_LLM_PROVIDER",
      value: "openai",
    });
    expect(key.secretData).toEqual({ OPENAI_API_KEY: "sk-o" });

    const codex = resolveProvider(
      baseSpec({ anthropicApiKey: undefined, codexAuthJson: '{"tokens":{}}' }),
    );
    expect(codex.type).toBe("openai");
    expect(codex.plainEnv).toContainEqual({
      name: "BANDOLIER_LLM_PROVIDER",
      value: "chatgpt",
    });
    expect(codex.secretData).toEqual({ CODEX_AUTH_JSON: '{"tokens":{}}' });
  });

  it("routes Gemini through the proxy's vertex backend with inline creds", () => {
    const p = resolveProvider(
      baseSpec({ anthropicApiKey: undefined, geminiApiKey: '{"project":1}' }),
    );
    expect(p.type).toBe("gemini");
    expect(p.plainEnv).toContainEqual({
      name: "BANDOLIER_LLM_PROVIDER",
      value: "vertex",
    });
    expect(p.secretRefs).toEqual([
      { key: "GOOGLE_APPLICATION_CREDENTIALS_JSON" },
    ]);
    expect(p.secretData).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"project":1}',
    });
  });
});

// ── buildEnvVars ──────────────────────────────────────────────────────────────

describe("buildEnvVars", () => {
  it("derives every provider env ref from the descriptor's secretRefs", () => {
    const provider = resolveProvider(baseSpec());
    const env = buildEnvVars(baseSpec(), "job-1", provider);
    expect(env).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      valueFrom: {
        secretKeyRef: {
          name: "job-1-creds",
          key: "ANTHROPIC_API_KEY",
          optional: false,
        },
      },
    });
    // GITHUB_TOKEN is always an optional ref so tokenless runs share the shape.
    expect(env).toContainEqual({
      name: "GITHUB_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: "job-1-creds",
          key: "GITHUB_TOKEN",
          optional: true,
        },
      },
    });
  });

  it("forwards effort for every provider", () => {
    const claude = buildEnvVars(
      baseSpec({ effort: "high" }),
      "j",
      resolveProvider(baseSpec()),
    );
    expect(claude.find((e) => e.name === "CLAUDE_EFFORT")?.value).toBe("high");
    const openaiSpec = baseSpec({
      anthropicApiKey: undefined,
      openaiApiKey: "sk-o",
      effort: "high",
    });
    const openai = buildEnvVars(openaiSpec, "j", resolveProvider(openaiSpec));
    expect(openai.find((e) => e.name === "CLAUDE_EFFORT")?.value).toBe("high");
  });

  it("defaults MAX_TURNS to unlimited", () => {
    const env = buildEnvVars(baseSpec(), "j", resolveProvider(baseSpec()));
    expect(env.find((e) => e.name === "MAX_TURNS")?.value).toBe(
      String(DEFAULT_MAX_TURNS),
    );
  });
});

// ── ensureNamespace ───────────────────────────────────────────────────────────

describe("ensureNamespace", () => {
  it("returns true after creating the namespace", async () => {
    await expect(ensureNamespace("ns1", "kc")).resolves.toBe(true);
    expect(createNamespace).toHaveBeenCalledWith({
      body: {
        metadata: {
          name: "ns1",
          labels: { "app.kubernetes.io/managed-by": "bandolier" },
        },
      },
    });
    expect(getCoreV1Api).toHaveBeenCalledWith("kc");
  });

  it("returns false when the namespace already exists (409)", async () => {
    createNamespace.mockRejectedValueOnce(conflict());
    await expect(ensureNamespace("ns1", "kc")).resolves.toBe(false);
  });

  it("rethrows non-conflict failures", async () => {
    createNamespace.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: 500 }),
    );
    await expect(ensureNamespace("ns1", "kc")).rejects.toThrow("forbidden");
  });

  it("skips the network policy entirely when disabled", async () => {
    await ensureNamespace("ns1", "kc");
    expect(getNetworkingV1Api).not.toHaveBeenCalled();
  });

  it("applies the built-in policy with the configured CIDR block list when enabled", async () => {
    mockEnv.AGENT_NETWORK_POLICY = "true";
    await ensureNamespace("ns1", "kc");
    expect(buildNetworkPolicyBody).toHaveBeenCalledWith(
      "ns1",
      ["10.0.0.0/8"],
      undefined,
    );
    expect(createNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: "ns1",
      body: DEFAULT_POLICY_BODY,
    });
    expect(replaceNamespacedNetworkPolicy).not.toHaveBeenCalled();
  });

  it("replaces the existing policy on a conflict so config changes take effect", async () => {
    mockEnv.AGENT_NETWORK_POLICY = "true";
    createNamespacedNetworkPolicy.mockRejectedValueOnce(conflict());
    await ensureNamespace("ns1", "kc");
    expect(replaceNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "bandolier-agent-isolation",
      namespace: "ns1",
      body: DEFAULT_POLICY_BODY,
    });
  });

  it("fails the deploy when the policy can't be applied (non-409)", async () => {
    mockEnv.AGENT_NETWORK_POLICY = "true";
    createNamespacedNetworkPolicy.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: 403 }),
    );
    await expect(ensureNamespace("ns1", "kc")).rejects.toThrow("denied");
  });

  it("applies the repo's custom policy YAML instead of the built-in body", async () => {
    mockEnv.AGENT_NETWORK_POLICY = "true";
    await ensureNamespace("ns1", "kc", { policyYaml: "kind: NetworkPolicy" });
    expect(buildCustomNetworkPolicyBody).toHaveBeenCalledWith(
      "ns1",
      "kind: NetworkPolicy",
    );
    expect(buildNetworkPolicyBody).not.toHaveBeenCalled();
    expect(createNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: "ns1",
      body: CUSTOM_POLICY_BODY,
    });
  });
});

// ── ensureServiceAccount ──────────────────────────────────────────────────────

describe("ensureServiceAccount", () => {
  it("creates the account without token automount and returns true", async () => {
    await expect(
      ensureServiceAccount("ns1", "bandolier-agent", "kc"),
    ).resolves.toBe(true);
    const call = createNamespacedServiceAccount.mock.calls[0]![0];
    expect(call.namespace).toBe("ns1");
    expect(call.body.metadata.name).toBe("bandolier-agent");
    expect(call.body.metadata.namespace).toBe("ns1");
    // Agents must not get in-cluster API credentials mounted.
    expect(call.body.automountServiceAccountToken).toBe(false);
  });

  it("returns false when the account already exists (409)", async () => {
    createNamespacedServiceAccount.mockRejectedValueOnce(conflict());
    await expect(
      ensureServiceAccount("ns1", "bandolier-agent", "kc"),
    ).resolves.toBe(false);
  });

  it("rethrows other failures", async () => {
    createNamespacedServiceAccount.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: 403 }),
    );
    await expect(
      ensureServiceAccount("ns1", "bandolier-agent", "kc"),
    ).rejects.toThrow("forbidden");
  });
});
