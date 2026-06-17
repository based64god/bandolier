"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import { parseAwsCredentials } from "./parse-aws";
import { SearchableSelect } from "./searchable-select";

function CredFeedback({
  error,
  ok,
}: {
  error?: string | null;
  ok?: string | null;
}) {
  if (!error && !ok) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-xs ${
        error
          ? "border-red-500/30 bg-red-500/10 text-red-400"
          : "border-green-500/30 bg-green-500/10 text-green-300"
      }`}
    >
      {error ?? ok}
    </p>
  );
}

// Anthropic key shared by everyone working on this repo. Admin-only (the whole
// modal is gated on repo admin server-side).
function RepoAnthropicSection({
  repoFullName,
  status,
}: {
  repoFullName: string;
  status?: { configured: boolean; apiKeyMasked?: string };
}) {
  const utils = api.useUtils();
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setAnthropic.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setApiKey("");
      setResult("Saved and verified ✓");
    },
  });
  const remove = api.webhooks.deleteAnthropic.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-purple-300">
        Anthropic API key
      </h4>
      {status?.configured ? (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <code className="text-purple-300">{status.apiKeyMasked}</code>
          <button
            onClick={() => remove.mutate({ repoFullName })}
            disabled={remove.isPending}
            className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            save.mutate({ repoFullName, apiKey });
          }}
          className="flex gap-2"
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-…"
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={save.isPending || !apiKey}
            className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {save.isPending ? "Verifying…" : "Save"}
          </button>
        </form>
      )}
      <CredFeedback error={save.error?.message} ok={result} />
    </div>
  );
}

// OpenAI key shared by everyone working on this repo (used via the Codex CLI).
// Admin-only, like the other shared credentials.
function RepoOpenAISection({
  repoFullName,
  status,
}: {
  repoFullName: string;
  status?: { configured: boolean; apiKeyMasked?: string };
}) {
  const utils = api.useUtils();
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setOpenai.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setApiKey("");
      setResult("Saved and verified ✓");
    },
  });
  const remove = api.webhooks.deleteOpenai.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-teal-300">OpenAI API key</h4>
      {status?.configured ? (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <code className="text-teal-300">{status.apiKeyMasked}</code>
          <button
            onClick={() => remove.mutate({ repoFullName })}
            disabled={remove.isPending}
            className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            save.mutate({ repoFullName, apiKey });
          }}
          className="flex gap-2"
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-teal-500/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={save.isPending || !apiKey}
            className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {save.isPending ? "Verifying…" : "Save"}
          </button>
        </form>
      )}
      <CredFeedback error={save.error?.message} ok={result} />
    </div>
  );
}

// Gemini project credentials shared by everyone working on this repo (a Google
// Cloud service-account key, used via the Antigravity CLI). Admin-only, like the
// other shared credentials.
function RepoGeminiSection({
  repoFullName,
  status,
}: {
  repoFullName: string;
  status?: {
    configured: boolean;
    projectId?: string | null;
    clientEmail?: string | null;
  };
}) {
  const utils = api.useUtils();
  const [credentials, setCredentials] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setGemini.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setCredentials("");
      setResult("Saved and verified ✓");
    },
  });
  const remove = api.webhooks.deleteGemini.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-blue-300">
        Gemini (Google Cloud project credentials)
      </h4>
      {status?.configured ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate text-blue-300">
              {status.clientEmail ?? "service account"}
            </div>
            {status.projectId && (
              <div className="truncate text-xs text-white/40">
                project: {status.projectId}
              </div>
            )}
          </div>
          <button
            onClick={() => remove.mutate({ repoFullName })}
            disabled={remove.isPending}
            className="shrink-0 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            save.mutate({ repoFullName, credentials });
          }}
          className="space-y-2"
        >
          <textarea
            rows={5}
            value={credentials}
            onChange={(e) => setCredentials(e.target.value)}
            placeholder={
              '{\n  "type": "service_account",\n  "project_id": "…",\n  "client_email": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----…"\n}'
            }
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-white/25 focus:border-blue-500/50 focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={save.isPending || !credentials}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending ? "Verifying…" : "Save"}
            </button>
          </div>
        </form>
      )}
      <CredFeedback error={save.error?.message} ok={result} />
    </div>
  );
}

// AWS Bedrock credentials shared by everyone working on this repo.
function RepoAwsSection({
  repoFullName,
  status,
}: {
  repoFullName: string;
  status?: {
    configured: boolean;
    accessKeyIdMasked?: string;
    region?: string;
    isTemporary?: boolean;
  };
}) {
  const utils = api.useUtils();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setAws.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setResult("Saved and verified ✓");
    },
  });
  const remove = api.webhooks.deleteAws.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  function handlePaste(text: string) {
    const parsed = parseAwsCredentials(text);
    if (!parsed) return;
    if (parsed.accessKeyId) setAccessKeyId(parsed.accessKeyId);
    if (parsed.secretAccessKey) setSecretAccessKey(parsed.secretAccessKey);
    if (parsed.sessionToken) setSessionToken(parsed.sessionToken);
    if (parsed.region) setRegion(parsed.region);
    setResult("Parsed pasted credentials — review and save.");
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-orange-300">
        AWS Bedrock credentials
      </h4>
      {status?.configured ? (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <span>
            <code className="text-orange-300">{status.accessKeyIdMasked}</code>
            <span className="ml-2 text-white/40">{status.region}</span>
            {status.isTemporary && (
              <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300/80">
                temporary
              </span>
            )}
          </span>
          <button
            onClick={() => remove.mutate({ repoFullName })}
            disabled={remove.isPending}
            className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <>
          <textarea
            rows={2}
            onChange={(e) => handlePaste(e.target.value)}
            placeholder={
              'Paste an AWS credentials block, e.g.\nexport AWS_ACCESS_KEY_ID="…"'
            }
            className="w-full rounded-lg border border-dashed border-white/15 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-white/25 focus:border-orange-500/50 focus:outline-none"
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              save.mutate({
                repoFullName,
                accessKeyId,
                secretAccessKey,
                sessionToken: sessionToken || undefined,
                region,
              });
            }}
            className="space-y-2"
          >
            <input
              required
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              placeholder="Access Key ID"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-orange-500/50 focus:outline-none"
            />
            <input
              required
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              placeholder="Secret Access Key"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-orange-500/50 focus:outline-none"
            />
            <input
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value)}
              placeholder="Session Token (optional)"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-orange-500/50 focus:outline-none"
            />
            <div className="flex gap-2">
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="Region"
                className="w-40 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-orange-500/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={save.isPending || !accessKeyId || !secretAccessKey}
                className="ml-auto rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {save.isPending ? "Verifying…" : "Save & verify"}
              </button>
            </div>
          </form>
        </>
      )}
      <CredFeedback error={save.error?.message} ok={result} />
    </div>
  );
}

// Kubeconfig shared by everyone working on this repo — the cluster its agents
// run on.
function RepoKubeconfigSection({
  repoFullName,
  configured,
}: {
  repoFullName: string;
  configured: boolean;
}) {
  const utils = api.useUtils();
  const [kubeconfig, setKubeconfig] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setKubeconfig.useMutation({
    onSuccess: (r) => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setKubeconfig("");
      setResult(`Saved and verified ✓ ${r.version ?? ""}`);
    },
  });
  const remove = api.webhooks.deleteKubeconfig.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-sky-300">Kubeconfig</h4>
      {configured ? (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <span className="text-white/70">A kubeconfig is configured.</span>
          <button
            onClick={() => remove.mutate({ repoFullName })}
            disabled={remove.isPending}
            className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            save.mutate({ repoFullName, kubeconfig });
          }}
          className="space-y-2"
        >
          <textarea
            required
            rows={5}
            value={kubeconfig}
            onChange={(e) => setKubeconfig(e.target.value)}
            placeholder={
              "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://…"
            }
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-white/25 focus:border-sky-500/50 focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={save.isPending || !kubeconfig}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending ? "Verifying…" : "Save & verify"}
            </button>
          </div>
        </form>
      )}
      <CredFeedback error={save.error?.message} ok={result} />
    </div>
  );
}

// Default model for webhook-triggered agents on this repo, chosen from the models
// the admin's + repo's credentials unlock. Saved immediately on selection.
function RepoDefaultModelSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config } = api.webhooks.getConfig.useQuery({ repoFullName });
  const { data: modelData, isLoading: modelsLoading } =
    api.models.list.useQuery({ repoFullName });
  const models = modelData?.models ?? [];
  const [result, setResult] = useState<string | null>(null);

  const setDefault = api.webhooks.setDefaultModel.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setResult("Saved ✓");
    },
  });

  return (
    <div className="space-y-2 border-t border-white/10 pt-5">
      <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
        Default webhook model
      </h3>
      <p className="text-xs text-white/40">
        The model webhook-triggered agents use on this repo (e.g. when an issue
        is opened). An issue label like{" "}
        <code className="rounded bg-white/10 px-1 text-white/60">
          model:opus
        </code>{" "}
        overrides it per issue — the text after <code>model:</code> is
        fuzzy-matched to the latest matching model. Leave unset to use the
        provider default.
      </p>
      <SearchableSelect
        options={models.map((m) => ({
          value: m.id,
          searchText: `${m.label} ${m.id} ${m.provider}`.toLowerCase(),
          label: (
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="truncate text-white">{m.label}</span>
              <span className="shrink-0 text-[10px] text-white/30">
                {m.provider}
              </span>
            </span>
          ),
        }))}
        value={config?.defaultWebhookModel ?? null}
        onChange={(v) => {
          setResult(null);
          setDefault.mutate({ repoFullName, model: v ?? "" });
        }}
        placeholder="Provider default"
        clearLabel="No default (provider default)"
        loading={modelsLoading}
        searchPlaceholder="Search models…"
        emptyText="No models available — configure credentials below."
      />
      <CredFeedback error={setDefault.error?.message} ok={result} />
    </div>
  );
}

// Repo-scoped shared infrastructure: kubeconfig + model credentials, plus the
// user-vs-repo preference toggle and a prominent security warning.
function RepoCredentialsSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: creds, isLoading } = api.webhooks.getCredentials.useQuery({
    repoFullName,
  });
  const setPrefer = api.webhooks.setPreferRepoCredentials.useMutation({
    onSuccess: () => utils.webhooks.getCredentials.invalidate({ repoFullName }),
  });

  return (
    <div className="space-y-4 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Shared credentials
        </h3>
        <p className="text-xs text-white/40">
          A cluster and model credentials shared by everyone who runs agents for
          this repo (including webhook-triggered runs), so they don&apos;t each
          need their own. Only repo admins can change them.
        </p>
      </div>

      {/* Security warning — these are shared infrastructure. */}
      <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
        <span aria-hidden className="text-amber-300">
          ⚠
        </span>
        <p className="text-xs text-amber-200/90">
          <span className="font-semibold">
            Repo-scoped credentials are shared infrastructure — secure them.
          </span>{" "}
          Every Bandolier user with access to this repo, and anyone whose GitHub
          activity triggers an agent, can run workloads with these credentials.
          Scope the cluster and model keys to only what this group should be
          trusted with, prefer short-lived/least-privilege credentials, and
          rotate them when collaborators change.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <>
          <RepoKubeconfigSection
            repoFullName={repoFullName}
            configured={creds?.hasKubeconfig ?? false}
          />
          <RepoAnthropicSection
            repoFullName={repoFullName}
            status={creds?.anthropic}
          />
          <RepoOpenAISection
            repoFullName={repoFullName}
            status={creds?.openai}
          />
          <RepoGeminiSection
            repoFullName={repoFullName}
            status={creds?.gemini}
          />
          <RepoAwsSection repoFullName={repoFullName} status={creds?.aws} />

          {/* Prefer user vs repo credentials. */}
          <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <h4 className="text-xs font-semibold text-white/70">
              Credential preference
            </h4>
            <p className="text-xs text-white/40">
              When a user has their own credentials and this repo has shared
              ones, which should an agent use?
            </p>
            <div className="flex gap-2 pt-0.5">
              <button
                type="button"
                onClick={() =>
                  setPrefer.mutate({ repoFullName, prefer: false })
                }
                disabled={setPrefer.isPending}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                  !creds?.preferRepoCredentials
                    ? "border-purple-500/50 bg-purple-500/15 text-purple-200"
                    : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                }`}
              >
                Prefer user credentials
              </button>
              <button
                type="button"
                onClick={() => setPrefer.mutate({ repoFullName, prefer: true })}
                disabled={setPrefer.isPending}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                  creds?.preferRepoCredentials
                    ? "border-purple-500/50 bg-purple-500/15 text-purple-200"
                    : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                }`}
              >
                Prefer repo credentials
              </button>
            </div>
            <p className="text-[11px] text-white/30">
              A server-wide kubeconfig, when set, always overrides both. The
              other side is still used as a fallback when the preferred one
              isn&apos;t configured.
            </p>
            {setPrefer.error && (
              <p className="text-xs text-red-400">{setPrefer.error.message}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function RepoConfigModal({
  repoFullName,
  onClose,
}: {
  repoFullName: string;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Uncontrolled so they pick up the saved value on load without a syncing
  // effect; read via the refs on submit.
  const prefixRef = useRef<HTMLInputElement>(null);
  const agentImageRef = useRef<HTMLInputElement>(null);

  function generateSecret() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const value = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    setSecret(value);
    setRevealed(true);
  }

  function copySecret() {
    if (!secret) return;
    void navigator.clipboard.writeText(secret).then(() => {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 1500);
    });
  }

  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });

  const save = api.webhooks.setConfig.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setSecret("");
      setResult("Saved ✓");
    },
  });
  const remove = api.webhooks.deleteConfig.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setResult(null);
    },
  });

  const [copied, setCopied] = useState(false);
  const payloadUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/github`
      : "/api/webhooks/github";

  function copyUrl() {
    void navigator.clipboard.writeText(payloadUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-white/20 bg-[#0a0a1a]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">
              Repository configuration
            </h2>
            <code className="rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
              {repoFullName}
            </code>
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p className="text-xs text-white/40">
            Repository-level settings for this repo: the GitHub webhook that
            lets events trigger agents, and the agent image those agents run on.
            Set a webhook secret here, then add the webhook in GitHub using the
            details below.
          </p>

          {/* Current status */}
          {!isLoading && config?.hasSecret && (
            <div className="flex items-center justify-between rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2.5 text-sm">
              <span className="text-green-300/90">
                A webhook secret is configured for this repo.
              </span>
              <button
                onClick={() => remove.mutate({ repoFullName })}
                disabled={remove.isPending}
                className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              save.mutate({
                repoFullName,
                secret: secret || undefined,
                prefix: prefixRef.current?.value ?? "",
                agentImage: agentImageRef.current?.value ?? "",
              });
            }}
            className="space-y-4"
          >
            {/* Secret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Webhook secret
              </label>
              <div className="flex gap-2">
                <input
                  type={revealed ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    config?.hasSecret
                      ? "Leave blank to keep current secret"
                      : "Secret"
                  }
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={
                    save.isPending || (secret.length > 0 && secret.length < 8)
                  }
                  className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={generateSecret}
                  className="rounded bg-white/10 px-2 py-1 text-white/70 hover:bg-white/20 hover:text-white"
                >
                  Generate
                </button>
                <button
                  type="button"
                  onClick={copySecret}
                  disabled={!secret}
                  className="rounded bg-white/10 px-2 py-1 text-white/70 hover:bg-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {secretCopied ? "Copied" : "Copy"}
                </button>
                {secret && (
                  <button
                    type="button"
                    onClick={() => setRevealed((r) => !r)}
                    className="text-white/40 hover:text-white/70"
                  >
                    {revealed ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              <p className="text-xs text-white/30">
                Generate a secret, save it here, and paste the same value into
                the webhook&apos;s “Secret” field in GitHub.
              </p>
            </div>

            {/* Trigger prefix */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Trigger prefix{" "}
                <span className="font-normal text-white/30">(optional)</span>
              </label>
              <input
                key={
                  config
                    ? `prefix-${String(config.updatedAt)}`
                    : "prefix-loading"
                }
                ref={prefixRef}
                type="text"
                defaultValue={config?.prefix ?? ""}
                placeholder="e.g. @bando"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
              />
              <p className="text-xs text-white/30">
                When set, only events whose title or body contains this text
                trigger an agent. Leave blank to act on all events. Saved with
                the button above.
              </p>
            </div>

            {/* Agent image */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Agent image{" "}
                <span className="font-normal text-white/30">(optional)</span>
              </label>
              <input
                key={
                  config ? `image-${String(config.updatedAt)}` : "image-loading"
                }
                ref={agentImageRef}
                type="text"
                defaultValue={config?.agentImage ?? ""}
                placeholder="e.g. ghcr.io/acme/bandolier-agent-harness:latest"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
              />
              <p className="text-xs text-white/30">
                Container image agents for this repo run on. Leave blank to use
                the server default. Saved with the button above.
              </p>
            </div>

            {save.error && (
              <p className="text-xs text-red-400">{save.error.message}</p>
            )}
            {result && !save.error && (
              <p className="text-xs text-green-300">{result}</p>
            )}
          </form>

          {/* Docs */}
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
              Set up in GitHub
            </h3>
            <ol className="list-decimal space-y-2 pl-4 text-xs text-white/60">
              <li>
                Open{" "}
                <a
                  href={`https://github.com/${repoFullName}/settings/hooks/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-300 hover:underline"
                >
                  Settings → Webhooks → Add webhook
                </a>
                .
              </li>
              <li>
                <span className="text-white/70">Payload URL</span> — set to:
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-black/40 px-2 py-1 text-[11px] text-white/80">
                    {payloadUrl}
                  </code>
                  <button
                    onClick={copyUrl}
                    className="rounded bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </li>
              <li>
                <span className="text-white/70">Content type</span> —{" "}
                <code className="text-white/80">application/json</code>.
              </li>
              <li>
                <span className="text-white/70">Secret</span> — paste the secret
                you saved above.
              </li>
              <li>
                <span className="text-white/70">Events</span> — choose “Let me
                select individual events” and enable:
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-white/55">
                  <li>
                    <span className="text-white/75">Issues</span> — opening an
                    issue dispatches an agent that fixes it and opens a PR.
                  </li>
                  <li>
                    <span className="text-white/75">Pull requests</span> — for
                    review/automation on PR activity.
                  </li>
                  <li>
                    <span className="text-white/75">Workflow runs</span> — to
                    react to CI results.
                  </li>
                </ul>
              </li>
              <li>Save the webhook in GitHub.</li>
            </ol>
            <p className="text-[11px] text-white/30">
              Agents triggered by a webhook run with the credentials of the
              GitHub user who initiated the event (e.g. the issue opener), so
              that user must be signed in to Bandolier with model and cluster
              credentials configured — or this repo must provide shared ones
              below.
            </p>
          </div>

          <RepoDefaultModelSection repoFullName={repoFullName} />

          <RepoCredentialsSection repoFullName={repoFullName} />
        </div>
      </div>
    </div>
  );
}
