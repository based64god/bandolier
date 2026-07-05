"use client";

import { useEffect, useRef, useState } from "react";

import { env } from "~/env";
import { EFFORT_LEVELS, providerSupportsEffort } from "~/lib/effort";
import { api } from "~/trpc/react";
import { parseAwsCredentials } from "./parse-aws";
import { ProviderTag } from "./provider-tag";
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
            className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-black hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
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

// The S3 bucket this repo's run artifacts (transcripts; historical context
// later) are stored in. Repo-owned and the only artifact store — there is
// deliberately no server-wide bucket — so the repo, not the Bandolier
// operator, owns its run data; without one, this repo's runs aren't persisted.
// Credentials stay server-side and are never injected into agent pods.
function RepoArtifactsSection({
  repoFullName,
  status,
}: {
  repoFullName: string;
  status?: {
    configured: boolean;
    bucket?: string;
    region?: string;
    endpoint?: string | null;
    accessKeyIdMasked?: string | null;
  };
}) {
  const utils = api.useUtils();
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [endpoint, setEndpoint] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.webhooks.setArtifacts.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setBucket("");
      setEndpoint("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setResult("Saved and verified ✓");
    },
  });
  const remove = api.webhooks.deleteArtifacts.useMutation({
    onSuccess: () => {
      void utils.webhooks.getCredentials.invalidate({ repoFullName });
      setResult(null);
    },
  });

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-emerald-300">
        Run artifact storage (S3)
      </h4>
      <p className="text-xs text-white/40">
        A bucket this repo owns for persisted run transcripts (and historical
        context, later). Without one, this repo&apos;s run transcripts are not
        persisted and vanish with the pod. Use credentials scoped to just this
        bucket — they stay on the server and are never given to agents.
      </p>
      {status?.configured ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate">
              <code className="text-emerald-300">{status.bucket}</code>
              <span className="ml-2 text-white/40">{status.region}</span>
            </div>
            <div className="truncate text-xs text-white/40">
              {status.endpoint && (
                <span className="mr-2">{status.endpoint}</span>
              )}
              {status.accessKeyIdMasked && (
                <code>{status.accessKeyIdMasked}</code>
              )}
            </div>
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
            save.mutate({
              repoFullName,
              bucket,
              region,
              endpoint: endpoint || undefined,
              accessKeyId,
              secretAccessKey,
            });
          }}
          className="space-y-2"
        >
          <div className="flex gap-2">
            <input
              required
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="Bucket name"
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
            />
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Region"
              className="w-40 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
            />
          </div>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="Custom endpoint for MinIO / S3-compatible (optional)"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
          />
          <input
            required
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="Access Key ID"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
          />
          <input
            required
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="Secret Access Key"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={
                save.isPending || !bucket || !accessKeyId || !secretAccessKey
              }
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-black hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
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
        options={models
          // The deploy picker offers a model once per credential kind, but the
          // webhook default is stored as a bare model id and webhook runs pick
          // credentials by precedence — so collapse duplicates to the first
          // (highest-precedence) entry per id.
          .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
          .map((m) => ({
            value: m.id,
            searchText:
              `${m.label} ${m.id} ${m.provider} ${m.auth ?? ""}`.toLowerCase(),
            label: (
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate text-white">{m.label}</span>
                <ProviderTag provider={m.provider} auth={m.auth} />
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

// Default reasoning effort for webhook-triggered Claude agents on this repo.
// Claude-only (Anthropic / Bedrock): hidden when the repo's configured provider
// can't use it. An issue `effort:<level>` label overrides it per issue.
function RepoDefaultEffortSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config } = api.webhooks.getConfig.useQuery({ repoFullName });
  const { data: providerInfo } = api.agents.providerInfo.useQuery({
    repoFullName,
  });
  const [result, setResult] = useState<string | null>(null);

  const setDefault = api.webhooks.setDefaultEffort.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setResult("Saved ✓");
    },
  });

  // Only the Claude providers run the `claude` CLI, which takes the effort flag.
  // Hide the control entirely for OpenAI/Gemini (or no provider).
  if (
    !providerInfo ||
    providerInfo.provider === "none" ||
    !providerSupportsEffort(providerInfo.provider)
  ) {
    return null;
  }

  const current = config?.defaultWebhookEffort ?? "";

  return (
    <div className="space-y-2 border-t border-white/10 pt-5">
      <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
        Default webhook effort
      </h3>
      <p className="text-xs text-white/40">
        Reasoning effort for webhook-triggered Claude agents on this repo. An
        issue label like{" "}
        <code className="rounded bg-white/10 px-1 text-white/60">
          effort:high
        </code>{" "}
        overrides it per issue. Leave as &ldquo;default&rdquo; to let the model
        decide.
      </p>
      <div className="flex gap-1.5">
        {(["", ...EFFORT_LEVELS] as const).map((level) => {
          const active = current === level;
          return (
            <button
              key={level || "default"}
              type="button"
              disabled={setDefault.isPending}
              onClick={() => {
                setResult(null);
                setDefault.mutate({ repoFullName, effort: level });
              }}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs capitalize transition disabled:opacity-50 ${
                active
                  ? "border-purple-500/50 bg-purple-500/15 text-white"
                  : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
              }`}
            >
              {level || "default"}
            </button>
          );
        })}
      </div>
      <CredFeedback error={setDefault.error?.message} ok={result} />
    </div>
  );
}

// Resumeable tasks: when a CI pipeline fails on a pull request Bandolier opened,
// auto-resume the run that produced it so the agent can investigate and push a
// fix. Off by default — it spends the run owner's credentials without a human in
// the loop, and is bounded server-side (once per failing commit, capped per PR).
function RepoResumeSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setResume = api.webhooks.setResumeOnCiFailure.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  const enabled = config?.resumeOnCiFailure ?? false;

  return (
    <div className="space-y-3 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Resume tasks on CI failure
        </h3>
        <p className="text-xs text-white/40">
          When a CI pipeline (a GitHub Actions{" "}
          <code className="rounded bg-white/10 px-1 text-white/60">
            workflow_run
          </code>
          ) fails on a pull request Bandolier produced, automatically resume the
          run that opened it — seeded with its transcript and continuing on the
          PR&apos;s branch — to investigate the failure and push a fix. Only
          open, same-repo pull requests resume; each failing commit resumes at
          most once, and a PR stops after a few attempts so a fix that never
          lands can&apos;t loop.
        </p>
      </div>
      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <div className="min-w-0 space-y-1">
              <h4 className="text-xs font-semibold text-white/70">
                Auto-resume on failing CI
              </h4>
              <p className="text-[11px] text-white/40">
                Resumes run as the task&apos;s owner and use their model and
                cluster credentials — enable only if that&apos;s intended.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Resume tasks on CI failure"
              onClick={() =>
                setResume.mutate({ repoFullName, enabled: !enabled })
              }
              disabled={setResume.isPending}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                enabled ? "bg-purple-500/70" : "bg-white/15"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          </div>
          {setResume.error && (
            <p className="text-xs text-red-400">{setResume.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Auto-merge: enable GitHub's native auto-merge on every pull request a Bandolier
// run reports as its output, so it lands once its required checks pass — no human
// click. Off by default — it lets an agent's work merge on its own. Auto-merge
// still respects the branch's protection rules, so a repo relies on its own
// required reviews/checks as the gate; a repo with none would merge immediately.
function RepoAutoMergeSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setAutoMerge = api.webhooks.setAutoMergeBandolierPrs.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  const enabled = config?.autoMergeBandolierPrs ?? false;

  return (
    <div className="space-y-3 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Auto-merge Bandolier PRs
        </h3>
        <p className="text-xs text-white/40">
          When a Bandolier run opens a pull request, automatically enable GitHub
          auto-merge on it, so it merges itself once its required checks pass
          and it&apos;s mergeable. Auto-merge still honors the branch&apos;s
          protection rules (required reviews / status checks) — this only lands
          what the repo&apos;s own gates already allow, so a branch with no
          protection would merge right away. The merge method is the first of
          merge / squash / rebase the repo permits.
        </p>
      </div>
      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <div className="min-w-0 space-y-1">
              <h4 className="text-xs font-semibold text-white/70">
                Auto-merge on passing checks
              </h4>
              <p className="text-[11px] text-white/40">
                Lets an agent&apos;s PR merge without a human pressing the
                button — enable only if your branch protection is the gate you
                trust.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Auto-merge Bandolier PRs"
              onClick={() =>
                setAutoMerge.mutate({ repoFullName, enabled: !enabled })
              }
              disabled={setAutoMerge.isPending}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                enabled ? "bg-purple-500/70" : "bg-white/15"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          </div>
          {setAutoMerge.error && (
            <p className="text-xs text-red-400">{setAutoMerge.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Default agent compute (CPU / memory limit) for every run on this repo —
// dashboard, issue, and webhook alike. Ordered against a user's own default by
// the prefer-repo-credentials toggle; a per-task override (deploy form, or an
// issue `cpu:`/`memory:` label) beats both.
function RepoDefaultComputeSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config } = api.webhooks.getConfig.useQuery({ repoFullName });
  // null = untouched; the stored value (or blank) shows until the user types.
  const [cpu, setCpu] = useState<string | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const cpuValue = cpu ?? config?.computeCpu ?? "";
  const memoryValue = memory ?? config?.computeMemory ?? "";
  const dirty = cpu !== null || memory !== null;

  const setDefault = api.webhooks.setDefaultCompute.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      void utils.agents.deployDefaults.invalidate();
      setCpu(null);
      setMemory(null);
      setResult("Saved ✓");
    },
  });

  return (
    <div className="space-y-2 border-t border-white/10 pt-5">
      <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
        Default agent compute
      </h3>
      <p className="text-xs text-white/40">
        CPU / memory limit for agents run on this repo, as Kubernetes quantities
        (e.g. <code className="rounded bg-white/10 px-1 text-white/60">4</code>{" "}
        CPUs,{" "}
        <code className="rounded bg-white/10 px-1 text-white/60">8Gi</code>{" "}
        memory). Issue labels like{" "}
        <code className="rounded bg-white/10 px-1 text-white/60">cpu:4</code>{" "}
        and{" "}
        <code className="rounded bg-white/10 px-1 text-white/60">
          memory:8Gi
        </code>{" "}
        override it per issue, as does the deploy form per task. Blank = the
        user&rsquo;s default, then the built-in limit.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          setDefault.mutate({
            repoFullName,
            cpu: cpuValue,
            memory: memoryValue,
          });
        }}
        className="flex items-end gap-3"
      >
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-white/60">CPU</label>
          <input
            type="text"
            value={cpuValue}
            onChange={(e) => {
              setCpu(e.target.value);
              setResult(null);
            }}
            placeholder="2"
            className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-white/60">
            Memory
          </label>
          <input
            type="text"
            value={memoryValue}
            onChange={(e) => {
              setMemory(e.target.value);
              setResult(null);
            }}
            placeholder="2Gi"
            className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={setDefault.isPending || !dirty}
          className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {setDefault.isPending ? "Saving…" : "Save"}
        </button>
      </form>
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
          Only collaborators with{" "}
          <span className="font-semibold">maintainer</span> access or higher can
          run agents on these credentials; less-privileged users must use their
          own (webhook-triggered runs by them are held for a maintainer&apos;s
          approval). Even so, scope the cluster and model keys to only what this
          group should be trusted with, prefer short-lived/least-privilege
          credentials, and rotate them when collaborators change.
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
          <RepoArtifactsSection
            repoFullName={repoFullName}
            status={creds?.artifacts}
          />

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
              The other side is still used as a fallback when the preferred one
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

// Per-repo network-policy egress toggles. Both loosen the default agent
// NetworkPolicy (deny inbound; egress only to DNS + the public internet on
// 80/443, with in-cluster private ranges blocked) and are OFF by default.
// Enabling either trades isolation for reach, so a prominent security warning
// sits above the toggles. Admin-only (the whole modal is gated server-side).
function RepoNetworkPolicySection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setPolicy = api.webhooks.setNetworkPolicy.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  // Advanced: raw NetworkPolicy YAML replacing the built-in policy (and the
  // toggles) entirely. Uncontrolled like the other config fields — the key
  // remounts it when a save changes updatedAt.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [yamlResult, setYamlResult] = useState<string | null>(null);
  const yamlRef = useRef<HTMLTextAreaElement>(null);
  const setPolicyYaml = api.webhooks.setNetworkPolicyYaml.useMutation({
    onSuccess: (_data, variables) => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setYamlResult(
        variables.yaml.trim()
          ? "Validated and saved ✓"
          : "Custom policy removed — back to the built-in policy.",
      );
    },
  });

  const allowPrivate = config?.allowPrivateEgress ?? false;
  const allowAllPorts = config?.allowAllPortsEgress ?? false;
  const hasCustomYaml = !!config?.networkPolicyYaml;
  const advancedVisible = showAdvanced || hasCustomYaml;

  return (
    <div className="space-y-4 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Network policy egress
        </h3>
        <p className="text-xs text-white/40">
          By default this repo&apos;s agent pods are locked down: all inbound
          traffic is denied and egress is limited to DNS and the public internet
          over HTTP(S), with in-cluster private ranges blocked. These toggles
          loosen that per repo. They only take effect when{" "}
          <code className="rounded bg-white/10 px-1 text-white/60">
            AGENT_NETWORK_POLICY
          </code>{" "}
          is enabled and the cluster runs a policy-enforcing CNI
          (Calico/Cilium).
        </p>
      </div>

      {/* Security warning — loosening egress weakens pod isolation. */}
      <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
        <span aria-hidden className="text-amber-300">
          ⚠
        </span>
        <p className="text-xs text-amber-200/90">
          <span className="font-semibold">
            Loosening egress weakens agent isolation — enable only when you
            trust the workloads this repo runs.
          </span>{" "}
          Agents run model-generated code with your credentials. Allowing
          in-cluster egress opens lateral movement to other pods and internal
          services; allowing all ports widens what an agent can connect to and
          exfiltrate over. Leave these off unless a specific task needs them,
          and turn them back off when it&apos;s done.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <NetworkPolicyToggle
            label="Allow in-cluster (private) egress"
            description="Drop the block on RFC-1918 ranges so agents can reach other pods and in-cluster services. Lateral-movement risk."
            enabled={allowPrivate}
            disabled={setPolicy.isPending || hasCustomYaml}
            onChange={(v) =>
              setPolicy.mutate({ repoFullName, allowPrivateEgress: v })
            }
          />
          <NetworkPolicyToggle
            label="Allow all egress ports"
            description="Permit outbound TCP on any port instead of only 80/443. Widens the exfiltration / arbitrary-protocol surface."
            enabled={allowAllPorts}
            disabled={setPolicy.isPending || hasCustomYaml}
            onChange={(v) =>
              setPolicy.mutate({ repoFullName, allowAllPortsEgress: v })
            }
          />
          {hasCustomYaml && (
            <p className="text-[11px] text-amber-300/80">
              A custom policy is active — these toggles are ignored until it is
              removed.
            </p>
          )}
          {setPolicy.error && (
            <p className="text-xs text-red-400">{setPolicy.error.message}</p>
          )}

          {/* Advanced: raw NetworkPolicy YAML. */}
          {!advancedVisible ? (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="text-xs text-white/40 hover:text-white/70"
            >
              ▸ Advanced: edit the raw NetworkPolicy YAML
            </button>
          ) : (
            <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-white/70">
                  Advanced: raw NetworkPolicy YAML
                  {hasCustomYaml && (
                    <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-normal text-amber-300/80">
                      custom policy active
                    </span>
                  )}
                </h4>
                {!hasCustomYaml && (
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(false)}
                    className="text-xs text-white/40 hover:text-white/70"
                  >
                    ▾ Hide
                  </button>
                )}
              </div>
              <p className="text-[11px] text-white/40">
                The exact policy applied to this repo&apos;s agent namespaces,
                replacing the toggles above entirely. Validated when saved. Keep
                a podSelector that matches the agent pods (
                <code className="rounded bg-white/10 px-1 text-white/60">
                  app: bandolier-agent
                </code>
                ); the policy&apos;s name and namespace are managed by Bandolier
                and overridden on apply.
              </p>
              <textarea
                key={
                  config
                    ? `netpol-yaml-${String(config.updatedAt)}`
                    : "netpol-yaml-loading"
                }
                ref={yamlRef}
                rows={14}
                spellCheck={false}
                defaultValue={
                  hasCustomYaml && config
                    ? config.networkPolicyYaml
                    : (config?.defaultNetworkPolicyYaml ?? "")
                }
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-white placeholder-white/25 focus:border-amber-500/50 focus:outline-none"
              />
              <div className="flex items-center justify-end gap-2">
                {hasCustomYaml && (
                  <button
                    type="button"
                    disabled={setPolicyYaml.isPending}
                    onClick={() => {
                      setYamlResult(null);
                      setPolicyYaml.mutate({ repoFullName, yaml: "" });
                    }}
                    className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Remove custom policy
                  </button>
                )}
                <button
                  type="button"
                  disabled={setPolicyYaml.isPending}
                  onClick={() => {
                    setYamlResult(null);
                    setPolicyYaml.mutate({
                      repoFullName,
                      yaml: yamlRef.current?.value ?? "",
                    });
                  }}
                  className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-black hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {setPolicyYaml.isPending
                    ? "Validating…"
                    : "Validate & save custom policy"}
                </button>
              </div>
              <CredFeedback
                error={setPolicyYaml.error?.message}
                ok={yamlResult}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A single on/off egress toggle, styled to match the two-button preference
// toggle used for credential preference.
function NetworkPolicyToggle({
  label,
  description,
  enabled,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h4 className="text-xs font-semibold text-white/70">{label}</h4>
          <p className="text-[11px] text-white/40">{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={label}
          onClick={() => onChange(!enabled)}
          disabled={disabled}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "bg-amber-500/70" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>
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
  const [result, setResult] = useState<string | null>(null);
  // Uncontrolled so they pick up the saved value on load without a syncing
  // effect; read via the refs on submit.
  const prefixRef = useRef<HTMLInputElement>(null);
  const agentImageRef = useRef<HTMLInputElement>(null);
  const systemPromptRef = useRef<HTMLTextAreaElement>(null);

  const utils = api.useUtils();
  const { data: config } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });

  const save = api.webhooks.setConfig.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setResult("Saved ✓");
    },
  });

  // The GitHub App install page; null when no slug is configured (self-hosters
  // who haven't set NEXT_PUBLIC_GITHUB_APP_SLUG), in which case we show generic
  // guidance instead of a broken link.
  const installUrl = env.NEXT_PUBLIC_GITHUB_APP_SLUG;

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
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-white/20 bg-[var(--surface-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 text-sm font-semibold text-white">
              Repository configuration
            </h2>
            <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
              {repoFullName}
            </code>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-white/40 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p className="text-xs text-white/40">
            Repository-level settings for this repo: when agents trigger, the
            image they run on, the system prompt they get, and the shared
            credentials they use. Event delivery is handled by the Bandolier
            GitHub App — install it on this repo (below) rather than configuring
            a webhook by hand.
          </p>

          {/* GitHub App install */}
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
              Install the GitHub App
            </h3>
            <p className="text-xs text-white/60">
              The Bandolier GitHub App delivers issue and pull-request events
              and posts updates as the bot. Installing it on{" "}
              <code className="text-white/80">{repoFullName}</code> wires up
              event delivery automatically — there is no webhook secret to
              manage.
            </p>
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500"
              >
                Install or configure on GitHub
              </a>
            ) : (
              <p className="text-[11px] text-white/30">
                Ask your Bandolier admin for the GitHub App install link (set{" "}
                <code className="text-white/50">
                  NEXT_PUBLIC_GITHUB_APP_SLUG
                </code>{" "}
                to surface it here).
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              save.mutate({
                repoFullName,
                prefix: prefixRef.current?.value ?? "",
                agentImage: agentImageRef.current?.value ?? "",
                systemPrompt: systemPromptRef.current?.value ?? "",
              });
            }}
            className="space-y-4"
          >
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
                trigger an agent. Leave blank to act on all events.
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
                placeholder="e.g. ghcr.io/based64god/bandolier-agent-harness:latest"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
              />
              <p className="text-xs text-white/30">
                Container image agents for this repo run on. Leave blank to use
                the server default.
              </p>
            </div>

            {/* Repository system prompt */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Repository system prompt{" "}
                <span className="font-normal text-white/30">(optional)</span>
              </label>
              <textarea
                key={
                  config
                    ? `sysprompt-${String(config.updatedAt)}`
                    : "sysprompt-loading"
                }
                ref={systemPromptRef}
                rows={5}
                defaultValue={config?.systemPrompt ?? ""}
                placeholder={
                  "e.g. Always write tests for new behaviour. Prefer small, focused commits. Follow the existing code style."
                }
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
              />
              <p className="text-xs text-white/30">
                A blanket instruction appended to the system prompt of every
                agent run for this repo — dashboard tasks, issues, and
                webhook-triggered runs alike. Layered on top of Bandolier&apos;s
                own framing, never replacing it. Leave blank for none.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={save.isPending}
                className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save settings"}
              </button>
              {save.error && (
                <p className="text-xs text-red-400">{save.error.message}</p>
              )}
              {result && !save.error && (
                <p className="text-xs text-green-300">{result}</p>
              )}
            </div>
          </form>

          <p className="text-[11px] text-white/30">
            Agents triggered by an event run with the credentials of the GitHub
            user who initiated it (e.g. the issue opener), so that user must be
            signed in to Bandolier with model and cluster credentials configured
            — or this repo must provide shared ones below.
          </p>

          <RepoDefaultModelSection repoFullName={repoFullName} />

          <RepoDefaultEffortSection repoFullName={repoFullName} />

          <RepoResumeSection repoFullName={repoFullName} />

          <RepoAutoMergeSection repoFullName={repoFullName} />

          <RepoDefaultComputeSection repoFullName={repoFullName} />

          <RepoCredentialsSection repoFullName={repoFullName} />

          <RepoNetworkPolicySection repoFullName={repoFullName} />
        </div>
      </div>
    </div>
  );
}
