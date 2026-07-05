"use client";

import { useState, useSyncExternalStore } from "react";

import { api } from "~/trpc/react";
import {
  ComputeForm,
  CredentialFeedback,
  MaskedCredentialRow,
  SecretForm,
  useCredentialMutations,
} from "./credential-ui";
import { Modal } from "./modal";
import { parseAwsCredentials } from "./parse-aws";

function AnthropicSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.anthropicStatus.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [oauthToken, setOauthToken] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.anthropicStatus.invalidate(),
  );

  const setAnthropic = api.account.setAnthropic.useMutation({
    onSuccess: () => onSave(() => setApiKey("")),
  });
  const setAnthropicOauth = api.account.setAnthropicOauth.useMutation({
    onSuccess: () => onSave(() => setOauthToken(""), "Saved ✓"),
  });
  const testAnthropic = api.account.testAnthropic.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteAnthropic = api.account.deleteAnthropic.useMutation({
    onSuccess: onRemove,
  });

  const saveError =
    setAnthropic.error?.message ?? setAnthropicOauth.error?.message;
  const bothConfigured = !!status?.apiKeyMasked && !!status?.oauthTokenMasked;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-purple-300">Anthropic</h3>

      {/* API key */}
      <p className="text-xs text-white/50">API key</p>
      {status?.apiKeyMasked ? (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testAnthropic.mutate({ kind: "api_key" });
          }}
          testPending={testAnthropic.isPending}
          onRemove={() => deleteAnthropic.mutate({ kind: "api_key" })}
          removePending={deleteAnthropic.isPending}
        >
          <code className="text-purple-300">{status.apiKeyMasked}</code>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent="purple"
          value={apiKey}
          onChange={setApiKey}
          onSubmit={() => {
            setResult(null);
            setAnthropic.mutate({ apiKey });
          }}
          placeholder="sk-ant-…"
          submitLabel="Save"
          pendingLabel="Verifying…"
          pending={setAnthropic.isPending}
          canSubmit={!!apiKey}
        />
      )}

      {/* Claude subscription (OAuth token) */}
      <p className="text-xs text-white/50">
        Claude subscription{" "}
        <span className="text-white/30">
          — run <code className="text-purple-300">claude setup-token</code> and
          paste the token
        </span>
      </p>
      {status?.oauthTokenMasked ? (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testAnthropic.mutate({ kind: "oauth_token" });
          }}
          testPending={testAnthropic.isPending}
          onRemove={() => deleteAnthropic.mutate({ kind: "oauth_token" })}
          removePending={deleteAnthropic.isPending}
        >
          <code className="text-purple-300">{status.oauthTokenMasked}</code>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent="purple"
          value={oauthToken}
          onChange={setOauthToken}
          onSubmit={() => {
            setResult(null);
            setAnthropicOauth.mutate({ oauthToken });
          }}
          placeholder="sk-ant-oat01-…"
          submitLabel="Save"
          pendingLabel="Saving…"
          pending={setAnthropicOauth.isPending}
          canSubmit={!!oauthToken}
        />
      )}

      {bothConfigured && (
        <p className="text-xs text-white/40">
          Both are set — the deploy dialog lists each model once per credential
          so you can pick per run; webhook and API runs use the API key.
        </p>
      )}

      <CredentialFeedback saveError={saveError} result={result} />
    </div>
  );
}

function OpenAISection() {
  const utils = api.useUtils();
  const { data: status } = api.account.openaiStatus.useQuery();
  const [apiKey, setApiKey] = useState("");
  const [authJson, setAuthJson] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.openaiStatus.invalidate(),
  );

  const setOpenai = api.account.setOpenai.useMutation({
    onSuccess: () => onSave(() => setApiKey("")),
  });
  const setCodexAuth = api.account.setCodexAuth.useMutation({
    onSuccess: () => onSave(() => setAuthJson(""), "Saved ✓"),
  });
  const testOpenai = api.account.testOpenai.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteOpenai = api.account.deleteOpenai.useMutation({
    onSuccess: onRemove,
  });

  const saveError = setOpenai.error?.message ?? setCodexAuth.error?.message;
  const bothConfigured = !!status?.apiKeyMasked && !!status?.chatgptConfigured;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-teal-300">OpenAI</h3>

      {/* API key */}
      <p className="text-xs text-white/50">API key</p>
      {status?.apiKeyMasked ? (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testOpenai.mutate({ kind: "api_key" });
          }}
          testPending={testOpenai.isPending}
          onRemove={() => deleteOpenai.mutate({ kind: "api_key" })}
          removePending={deleteOpenai.isPending}
        >
          <code className="text-teal-300">{status.apiKeyMasked}</code>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent="teal"
          value={apiKey}
          onChange={setApiKey}
          onSubmit={() => {
            setResult(null);
            setOpenai.mutate({ apiKey });
          }}
          placeholder="sk-…"
          submitLabel="Save"
          pendingLabel="Verifying…"
          pending={setOpenai.isPending}
          canSubmit={!!apiKey}
        />
      )}

      {/* ChatGPT subscription (Codex auth.json) */}
      <p className="text-xs text-white/50">
        ChatGPT subscription{" "}
        <span className="text-white/30">
          — run <code className="text-teal-300">codex login</code>, then paste{" "}
          <code className="text-teal-300">~/.codex/auth.json</code>
        </span>
      </p>
      {status?.chatgptConfigured ? (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testOpenai.mutate({ kind: "chatgpt" });
          }}
          testPending={testOpenai.isPending}
          onRemove={() => deleteOpenai.mutate({ kind: "chatgpt" })}
          removePending={deleteOpenai.isPending}
        >
          <code className="text-teal-300">ChatGPT sign-in</code>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent="teal"
          variant="textarea"
          value={authJson}
          onChange={setAuthJson}
          onSubmit={() => {
            setResult(null);
            setCodexAuth.mutate({ authJson });
          }}
          placeholder='{"OPENAI_API_KEY": null, "tokens": { … }}'
          rows={3}
          submitLabel="Save"
          pendingLabel="Saving…"
          pending={setCodexAuth.isPending}
          canSubmit={!!authJson}
        />
      )}

      {bothConfigured && (
        <p className="text-xs text-white/40">
          Both are set — the deploy dialog lists each model once per credential
          so you can pick per run; webhook and API runs use the API key.
        </p>
      )}

      <CredentialFeedback saveError={saveError} result={result} />
    </div>
  );
}

function GeminiSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.geminiStatus.useQuery();
  const [credentials, setCredentials] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.geminiStatus.invalidate(),
  );

  const setGemini = api.account.setGemini.useMutation({
    onSuccess: () => onSave(() => setCredentials("")),
  });
  const testGemini = api.account.testGemini.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });
  const deleteGemini = api.account.deleteGemini.useMutation({
    onSuccess: onRemove,
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-blue-300">
        Gemini (Google Cloud project credentials)
      </h3>

      {status?.configured && (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testGemini.mutate();
          }}
          testPending={testGemini.isPending}
          onRemove={() => deleteGemini.mutate()}
          removePending={deleteGemini.isPending}
        >
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
        </MaskedCredentialRow>
      )}

      {!status?.configured && (
        <SecretForm
          accent="blue"
          variant="textarea"
          value={credentials}
          onChange={setCredentials}
          onSubmit={() => {
            setResult(null);
            setGemini.mutate({ credentials });
          }}
          rows={6}
          placeholder={
            '{\n  "type": "service_account",\n  "project_id": "…",\n  "client_email": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----…"\n}'
          }
          submitLabel="Save"
          pendingLabel="Verifying…"
          pending={setGemini.isPending}
          canSubmit={!!credentials}
          align="end"
        >
          <p className="text-xs text-white/40">
            Paste a Google Cloud service-account key (JSON). The agent
            authenticates to your project via Application Default Credentials.
          </p>
        </SecretForm>
      )}

      <CredentialFeedback
        saveError={setGemini.error?.message}
        result={result}
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
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.awsStatus.invalidate(),
  );

  const setAws = api.account.setAws.useMutation({
    onSuccess: () =>
      onSave(() => {
        setAccessKeyId("");
        setSecretAccessKey("");
        setSessionToken("");
      }),
  });
  const testAws = api.account.testAws.useMutation({
    onSuccess: (r) =>
      setResult(r.valid ? `Valid ✓ ${r.arn ?? ""}` : `Invalid: ${r.error}`),
  });
  const deleteAws = api.account.deleteAws.useMutation({ onSuccess: onRemove });

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
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            testAws.mutate();
          }}
          testPending={testAws.isPending}
          onRemove={() => deleteAws.mutate()}
          removePending={deleteAws.isPending}
        >
          <span>
            <code className="text-orange-300">{status.accessKeyIdMasked}</code>
            <span className="ml-2 text-white/40">{status.region}</span>
            {status.isTemporary && (
              <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300/80">
                temporary
              </span>
            )}
          </span>
        </MaskedCredentialRow>
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

      <CredentialFeedback saveError={setAws.error?.message} result={result} />
    </div>
  );
}

function KubeconfigSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.kubeconfigStatus.useQuery();
  const [kubeconfig, setKubeconfig] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.kubeconfigStatus.invalidate(),
  );

  const save = api.account.setKubeconfig.useMutation({
    onSuccess: (r) =>
      onSave(
        () => setKubeconfig(""),
        `Saved and verified ✓ ${r.version ?? ""}`,
      ),
  });
  const test = api.account.testKubeconfig.useMutation({
    onSuccess: (r) =>
      setResult(r.valid ? `Valid ✓ ${r.version ?? ""}` : `Invalid: ${r.error}`),
  });
  const remove = api.account.deleteKubeconfig.useMutation({
    onSuccess: onRemove,
  });

  return (
    <div className="space-y-3 border-t border-white/10 pt-6">
      <h3 className="text-sm font-semibold text-sky-300">Kubeconfig</h3>

      {status?.configured && (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            test.mutate();
          }}
          testPending={test.isPending}
          onRemove={() => remove.mutate()}
          removePending={remove.isPending}
        >
          <span className="text-white/70">A kubeconfig is configured.</span>
        </MaskedCredentialRow>
      )}

      {!status?.configured && (
        <>
          <p className="text-xs text-white/40">
            Paste a kubeconfig to run your agents in your own cluster. It&apos;s
            verified against the cluster&apos;s API before saving.
          </p>

          <KubeconfigSetupHelp />

          <SecretForm
            accent="sky"
            variant="textarea"
            required
            value={kubeconfig}
            onChange={setKubeconfig}
            onSubmit={() => {
              setResult(null);
              save.mutate({ kubeconfig });
            }}
            rows={6}
            placeholder={
              "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://…"
            }
            submitLabel="Save & verify"
            pendingLabel="Verifying…"
            pending={save.isPending}
            canSubmit={!!kubeconfig}
            align="end"
          />
        </>
      )}

      <CredentialFeedback saveError={save.error?.message} result={result} />
    </div>
  );
}

function ComputeSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.computeStatus.useQuery();
  const save = api.account.setCompute.useMutation({
    onSuccess: () => {
      void utils.account.computeStatus.invalidate();
      void utils.agents.deployDefaults.invalidate();
    },
  });

  return (
    <ComputeForm
      accent="emerald"
      containerClassName="space-y-3 border-t border-white/10 pt-6"
      title="Agent compute"
      titleClassName="text-sm font-semibold text-emerald-300"
      description={
        <>
          Default CPU / memory limit for the agents you deploy, as Kubernetes
          quantities (e.g. <code className="text-white/60">4</code> CPUs,{" "}
          <code className="text-white/60">8Gi</code> memory). A repository can
          set its own default, and each task can override both. Blank = the
          built-in limit.
        </>
      }
      values={{ cpu: status?.cpu, memory: status?.memory }}
      onSave={(compute) => save.mutateAsync(compute)}
      pending={save.isPending}
      error={save.error?.message}
    />
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

      <CredentialFeedback
        saveError={create.error?.message ?? revoke.error?.message}
      />

      <ApiKeyUsageExample token={newToken} />
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      title="Settings"
      headerClassName="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4"
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
    >
      <div className="space-y-6 overflow-y-auto px-5 py-5">
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
        <ComputeSection />
        <ApiKeysSection />
      </div>
    </Modal>
  );
}
