"use client";

import { useState } from "react";

import {
  CredentialFeedback,
  MaskedCredentialRow,
  SecretForm,
  useCredentialMutations,
} from "~/app/dashboard/_components/credential-ui";
import { parseAwsCredentials } from "~/app/dashboard/_components/parse-aws";
import { api } from "~/trpc/react";

// The user-scoped model-provider credential sections (Anthropic, OpenAI,
// Gemini, AWS Bedrock), one card each on the settings page's "Model providers"
// panel. Repo-scoped overrides live on the repo settings page and share the
// same credential-ui primitives.

export function AnthropicSection() {
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

export function OpenAISection() {
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

export function GeminiSection() {
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

export function AwsSection() {
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
