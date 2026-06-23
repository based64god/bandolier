"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { api } from "~/trpc/react";
import { parseAwsCredentials } from "./parse-aws";

function StatusFeedback({
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

function AnthropicSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.anthropicStatus.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const setAnthropic = api.account.setAnthropic.useMutation({
    onSuccess: () => {
      void utils.account.anthropicStatus.invalidate();
      setApiKey("");
      setResult("Saved and verified ✓");
    },
  });
  const testAnthropic = api.account.testAnthropic.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteAnthropic = api.account.deleteAnthropic.useMutation({
    onSuccess: () => {
      void utils.account.anthropicStatus.invalidate();
      setResult(null);
    },
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-purple-300">
        Anthropic API key
      </h3>

      {status?.configured && (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
          <code className="text-purple-300">{status.apiKeyMasked}</code>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setResult("Testing…");
                testAnthropic.mutate();
              }}
              disabled={testAnthropic.isPending}
              className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={() => deleteAnthropic.mutate()}
              disabled={deleteAnthropic.isPending}
              className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {!status?.configured && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            setAnthropic.mutate({ apiKey });
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
            disabled={setAnthropic.isPending || !apiKey}
            className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {setAnthropic.isPending ? "Verifying…" : "Save"}
          </button>
        </form>
      )}

      <StatusFeedback
        error={
          setAnthropic.error?.message ??
          (result?.startsWith("Invalid") ? result : null)
        }
        ok={result && !result.startsWith("Invalid") ? result : null}
      />
    </div>
  );
}

function OpenAISection() {
  const utils = api.useUtils();
  const { data: status } = api.account.openaiStatus.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const setOpenai = api.account.setOpenai.useMutation({
    onSuccess: () => {
      void utils.account.openaiStatus.invalidate();
      setApiKey("");
      setResult("Saved and verified ✓");
    },
  });
  const testOpenai = api.account.testOpenai.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteOpenai = api.account.deleteOpenai.useMutation({
    onSuccess: () => {
      void utils.account.openaiStatus.invalidate();
      setResult(null);
    },
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-teal-300">OpenAI API key</h3>

      {status?.configured && (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
          <code className="text-teal-300">{status.apiKeyMasked}</code>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setResult("Testing…");
                testOpenai.mutate();
              }}
              disabled={testOpenai.isPending}
              className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={() => deleteOpenai.mutate()}
              disabled={deleteOpenai.isPending}
              className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {!status?.configured && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            setOpenai.mutate({ apiKey });
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
            disabled={setOpenai.isPending || !apiKey}
            className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {setOpenai.isPending ? "Verifying…" : "Save"}
          </button>
        </form>
      )}

      <StatusFeedback
        error={
          setOpenai.error?.message ??
          (result?.startsWith("Invalid") ? result : null)
        }
        ok={result && !result.startsWith("Invalid") ? result : null}
      />
    </div>
  );
}

function GeminiSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.geminiStatus.useQuery();
  const [credentials, setCredentials] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const setGemini = api.account.setGemini.useMutation({
    onSuccess: () => {
      void utils.account.geminiStatus.invalidate();
      setCredentials("");
      setResult("Saved and verified ✓");
    },
  });
  const testGemini = api.account.testGemini.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteGemini = api.account.deleteGemini.useMutation({
    onSuccess: () => {
      void utils.account.geminiStatus.invalidate();
      setResult(null);
    },
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-blue-300">
        Gemini (Google Cloud project credentials)
      </h3>

      {status?.configured && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
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
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => {
                setResult("Testing…");
                testGemini.mutate();
              }}
              disabled={testGemini.isPending}
              className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={() => deleteGemini.mutate()}
              disabled={deleteGemini.isPending}
              className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {!status?.configured && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            setGemini.mutate({ credentials });
          }}
          className="space-y-2"
        >
          <p className="text-xs text-white/40">
            Paste a Google Cloud service-account key (JSON). The agent
            authenticates to your project via Application Default Credentials.
          </p>
          <textarea
            rows={6}
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
              disabled={setGemini.isPending || !credentials}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-black hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {setGemini.isPending ? "Verifying…" : "Save"}
            </button>
          </div>
        </form>
      )}

      <StatusFeedback
        error={
          setGemini.error?.message ??
          (result?.startsWith("Invalid") ? result : null)
        }
        ok={result && !result.startsWith("Invalid") ? result : null}
      />
    </div>
  );
}

function AwsSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.awsStatus.useQuery();

  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [result, setResult] = useState<string | null>(null);

  const setAws = api.account.setAws.useMutation({
    onSuccess: () => {
      void utils.account.awsStatus.invalidate();
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setResult("Saved and verified ✓");
    },
  });
  const testAws = api.account.testAws.useMutation({
    onSuccess: (r) =>
      setResult(r.valid ? `Valid ✓ ${r.arn ?? ""}` : `Invalid: ${r.error}`),
  });
  const deleteAws = api.account.deleteAws.useMutation({
    onSuccess: () => {
      void utils.account.awsStatus.invalidate();
      setResult(null);
    },
  });

  // Auto-fill the individual fields when a credentials block is pasted.
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
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-orange-300">
        AWS Bedrock credentials
      </h3>

      {status?.configured && (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
          <span>
            <code className="text-orange-300">{status.accessKeyIdMasked}</code>
            <span className="ml-2 text-white/40">{status.region}</span>
            {status.isTemporary && (
              <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300/80">
                temporary
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setResult("Testing…");
                testAws.mutate();
              }}
              disabled={testAws.isPending}
              className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={() => deleteAws.mutate()}
              disabled={deleteAws.isPending}
              className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {!status?.configured && (
        <>
          {/* Paste-from-AWS block */}
          <textarea
            rows={3}
            onChange={(e) => handlePaste(e.target.value)}
            placeholder={
              'Paste an AWS credentials block here, e.g.\nexport AWS_ACCESS_KEY_ID="ASIA…"\nexport AWS_SECRET_ACCESS_KEY="…"\nexport AWS_SESSION_TOKEN="…"'
            }
            className="w-full rounded-lg border border-dashed border-white/15 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-white/25 focus:border-orange-500/50 focus:outline-none"
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              setAws.mutate({
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
                disabled={setAws.isPending || !accessKeyId || !secretAccessKey}
                className="ml-auto rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {setAws.isPending ? "Verifying…" : "Save & verify"}
              </button>
            </div>
          </form>
        </>
      )}

      <StatusFeedback
        error={
          setAws.error?.message ??
          (result?.startsWith("Invalid") ? result : null)
        }
        ok={result && !result.startsWith("Invalid") ? result : null}
      />
    </div>
  );
}

function KubeconfigSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.kubeconfigStatus.useQuery();
  const [kubeconfig, setKubeconfig] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const save = api.account.setKubeconfig.useMutation({
    onSuccess: (r) => {
      void utils.account.kubeconfigStatus.invalidate();
      setKubeconfig("");
      setResult(`Saved and verified ✓ ${r.version ?? ""}`);
    },
  });
  const test = api.account.testKubeconfig.useMutation({
    onSuccess: (r) =>
      setResult(r.valid ? `Valid ✓ ${r.version ?? ""}` : `Invalid: ${r.error}`),
  });
  const remove = api.account.deleteKubeconfig.useMutation({
    onSuccess: () => {
      void utils.account.kubeconfigStatus.invalidate();
      setResult(null);
    },
  });

  return (
    <div className="space-y-3 border-t border-white/10 pt-6">
      <h3 className="text-sm font-semibold text-sky-300">Kubeconfig</h3>

      {status?.configured && (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
          <span className="text-white/70">A kubeconfig is configured.</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setResult("Testing…");
                test.mutate();
              }}
              disabled={test.isPending}
              className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {!status?.configured && (
        <>
          <p className="text-xs text-white/40">
            Paste a kubeconfig to run your agents in your own cluster. It&apos;s
            verified against the cluster&apos;s API before saving.
          </p>

          <KubeconfigSetupHelp />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setResult(null);
              save.mutate({ kubeconfig });
            }}
            className="space-y-2"
          >
            <textarea
              required
              rows={6}
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
        </>
      )}

      <StatusFeedback
        error={
          save.error?.message ?? (result?.startsWith("Invalid") ? result : null)
        }
        ok={result && !result.startsWith("Invalid") ? result : null}
      />
    </div>
  );
}

function KubeconfigSetupHelp() {
  const [copied, setCopied] = useState(false);

  // Resolve the real host on the client so the command is ready to paste.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "https://<your-host>",
  );

  const command = `curl -fsSL ${origin}/setup.sh | bash`;

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
      <p className="text-xs text-white/50">
        Bandolier runs the Kubernetes client on its server, so it needs a
        self-contained, token-based kubeconfig — not one that shells out to{" "}
        <code className="text-white/60">aws</code>/
        <code className="text-white/60">gcloud</code> or references local cert
        files. Run this against your cluster (you need{" "}
        <code className="text-white/60">kubectl</code> admin access) to
        provision a ServiceAccount and print a kubeconfig you can paste below:
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-sky-200">
          {command}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-white/40">
        Add <code className="text-white/60">| bash -s -- --scoped</code> to bind
        a least-privilege role instead of cluster-admin, or{" "}
        <code className="text-white/60">--help</code> for more options.
      </p>
    </div>
  );
}

function ApiKeyUsageExample({ token }: { token: string | null }) {
  const [copied, setCopied] = useState(false);

  // Resolve the real host on the client so the snippet is ready to paste.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "https://<your-host>",
  );

  const authToken = token ?? "bnd_…";
  const example = `# List tasks for a repo
curl -H "Authorization: Bearer ${authToken}" \\
  ${origin}/api/v1/repos/<owner>/<repo>/tasks

# Launch a task
curl -X POST -H "Authorization: Bearer ${authToken}" -H "Content-Type: application/json" \\
  -d '{"task":"Fix the flaky test in auth.spec.ts"}' \\
  ${origin}/api/v1/repos/<owner>/<repo>/tasks`;

  return (
    <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/40">
          Use your key against the REST API under{" "}
          <code className="text-white/60">/api/v1</code>:
        </p>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(example);
            setCopied(true);
          }}
          className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded bg-black/30 px-2 py-2 font-mono text-[11px] leading-relaxed text-white/70">
        {example}
      </pre>
    </div>
  );
}

function ApiKeysSection() {
  const utils = api.useUtils();
  const { data: keys = [] } = api.apiKeys.list.useQuery();
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = api.apiKeys.create.useMutation({
    onSuccess: (r) => {
      void utils.apiKeys.list.invalidate();
      setNewToken(r.token);
      setCopied(false);
      setName("");
      setExpiresInDays("");
    },
  });
  const revoke = api.apiKeys.revoke.useMutation({
    onSuccess: () => utils.apiKeys.list.invalidate(),
  });

  return (
    <div className="space-y-3 border-t border-white/10 pt-6">
      <h3 className="text-sm font-semibold text-emerald-300">API keys</h3>
      <p className="text-xs text-white/40">
        Keys act as you, with your permissions, against the task API. The token
        is shown once — store it now.
      </p>

      {newToken && (
        <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
          <p className="text-xs text-emerald-300">
            Copy your new key now — it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1 text-xs text-emerald-200">
              {newToken}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(newToken);
                setCopied(true);
              }}
              className="shrink-0 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => setNewToken(null)}
              className="shrink-0 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="space-y-1.5">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="text-white/90">{k.name}</span>{" "}
                <code className="text-white/40">{k.prefix}…</code>
                <span className="ml-2 text-xs text-white/30">
                  {k.lastUsedAt
                    ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : "never used"}
                  {k.expiresAt
                    ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}`
                    : ""}
                </span>
              </span>
              <button
                onClick={() => revoke.mutate({ id: k.id })}
                disabled={revoke.isPending}
                className="ml-2 shrink-0 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const days = parseInt(expiresInDays, 10);
          create.mutate({
            name,
            expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined,
          });
        }}
        className="flex gap-2"
      >
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. CI bot)"
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
        />
        <input
          type="number"
          min={1}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
          placeholder="Days (optional)"
          className="w-36 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={create.isPending || !name}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Create"}
        </button>
      </form>

      <StatusFeedback error={create.error?.message ?? revoke.error?.message} />

      <ApiKeyUsageExample token={newToken} />
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
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
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-6 px-5 py-5">
          <p className="text-xs text-white/40">
            Configure how your agents reach their model. For Claude, AWS Bedrock
            takes precedence when both are set; otherwise your Anthropic key is
            used. OpenAI keys and Gemini project credentials add their models to
            the picker alongside Claude — you choose per deploy. Credentials are
            verified before they&apos;re saved and again before each deploy.
          </p>
          <AnthropicSection />
          <div className="border-t border-white/10" />
          <OpenAISection />
          <div className="border-t border-white/10" />
          <GeminiSection />
          <div className="border-t border-white/10" />
          <AwsSection />
          <KubeconfigSection />
          <ApiKeysSection />
        </div>
      </div>
    </div>
  );
}
