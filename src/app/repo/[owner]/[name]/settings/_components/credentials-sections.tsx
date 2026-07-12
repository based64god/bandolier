"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { SettingsCard } from "~/app/_components/settings-shell";
import {
  CredentialFeedback,
  MaskedCredentialRow,
  SecretForm,
  useCredentialMutations,
} from "~/app/dashboard/_components/credential-ui";
import { GenericProviderForm } from "~/app/dashboard/_components/generic-provider-form";
import {
  ProviderDirectory,
  type ProviderEntry,
} from "~/app/dashboard/_components/provider-directory";
import { parseAwsCredentials } from "~/app/dashboard/_components/parse-aws";
import type { RouterOutputs } from "~/trpc/react";

type Accent = "purple" | "teal" | "blue" | "orange" | "sky" | "emerald";

// Full literal class strings so Tailwind's JIT keeps them (a `text-${accent}-300`
// template would be purged).
const ACCENT_TEXT: Record<Accent, string> = {
  purple: "text-purple-300",
  teal: "text-teal-300",
  blue: "text-blue-300",
  orange: "text-orange-300",
  sky: "text-sky-300",
  emerald: "text-emerald-300",
};

// A single-key credential shared by everyone working on this repo (Anthropic,
// OpenAI, …). Admin-only (the whole page is gated on repo admin server-side).
// The providers differ only in label/accent/placeholder and which mutation
// pair saves and removes the key, so they're driven by config rather than
// copied per provider.
function RepoApiKeySection({
  repoFullName,
  status,
  label,
  accent,
  placeholder,
  hideHeading,
  save: saveMutation,
  remove: removeMutation,
}: {
  repoFullName: string;
  status?: { configured: boolean; apiKeyMasked?: string };
  label: string;
  accent: Accent;
  placeholder: string;
  hideHeading?: boolean;
  save: typeof api.webhooks.setAnthropic.useMutation;
  remove: typeof api.webhooks.deleteAnthropic.useMutation;
}) {
  const utils = api.useUtils();
  const [apiKey, setApiKey] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCredentials.invalidate({ repoFullName }),
  );

  const save = saveMutation({
    onSuccess: () => onSave(() => setApiKey("")),
  });
  const remove = removeMutation({ onSuccess: onRemove });

  return (
    <div className="space-y-2">
      {!hideHeading && (
        <h3 className={`text-sm font-semibold ${ACCENT_TEXT[accent]}`}>
          {label}
        </h3>
      )}
      {status?.configured ? (
        <MaskedCredentialRow
          onRemove={() => remove.mutate({ repoFullName })}
          removePending={remove.isPending}
        >
          <code className={ACCENT_TEXT[accent]}>{status.apiKeyMasked}</code>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent={accent}
          value={apiKey}
          onChange={setApiKey}
          onSubmit={() => {
            setResult(null);
            save.mutate({ repoFullName, apiKey });
          }}
          placeholder={placeholder}
          submitLabel="Save"
          pendingLabel="Verifying…"
          pending={save.isPending}
          canSubmit={!!apiKey}
        />
      )}
      <CredentialFeedback saveError={save.error?.message} result={result} />
    </div>
  );
}

// Anthropic key shared by everyone working on this repo. Admin-only.
function RepoAnthropicSection({
  repoFullName,
  status,
  hideHeading,
}: {
  repoFullName: string;
  status?: { configured: boolean; apiKeyMasked?: string };
  hideHeading?: boolean;
}) {
  return (
    <RepoApiKeySection
      repoFullName={repoFullName}
      status={status}
      label="Anthropic API key"
      accent="purple"
      placeholder="sk-ant-…"
      hideHeading={hideHeading}
      save={api.webhooks.setAnthropic.useMutation}
      remove={api.webhooks.deleteAnthropic.useMutation}
    />
  );
}

// OpenAI key shared by everyone working on this repo (served to Claude Code
// through the harness's embedded model proxy). Admin-only, like the other
// shared credentials.
function RepoOpenAISection({
  repoFullName,
  status,
  hideHeading,
}: {
  repoFullName: string;
  status?: { configured: boolean; apiKeyMasked?: string };
  hideHeading?: boolean;
}) {
  return (
    <RepoApiKeySection
      repoFullName={repoFullName}
      status={status}
      label="OpenAI API key"
      accent="teal"
      placeholder="sk-…"
      hideHeading={hideHeading}
      save={api.webhooks.setOpenai.useMutation}
      remove={api.webhooks.deleteOpenai.useMutation}
    />
  );
}

// Gemini project credentials shared by everyone working on this repo (a Google
// Cloud service-account key, used against Vertex AI through the harness's
// embedded model proxy). Admin-only, like the other shared credentials.
function RepoGeminiSection({
  repoFullName,
  status,
  hideHeading,
}: {
  repoFullName: string;
  status?: {
    configured: boolean;
    projectId?: string | null;
    clientEmail?: string | null;
  };
  hideHeading?: boolean;
}) {
  const utils = api.useUtils();
  const [credentials, setCredentials] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCredentials.invalidate({ repoFullName }),
  );

  const save = api.webhooks.setGemini.useMutation({
    onSuccess: () => onSave(() => setCredentials("")),
  });
  const remove = api.webhooks.deleteGemini.useMutation({ onSuccess: onRemove });

  return (
    <div className="space-y-2">
      {!hideHeading && (
        <h3 className="text-sm font-semibold text-blue-300">
          Gemini (Google Cloud project credentials)
        </h3>
      )}
      {status?.configured ? (
        <MaskedCredentialRow
          onRemove={() => remove.mutate({ repoFullName })}
          removePending={remove.isPending}
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
      ) : (
        <SecretForm
          accent="blue"
          variant="textarea"
          value={credentials}
          onChange={setCredentials}
          onSubmit={() => {
            setResult(null);
            save.mutate({ repoFullName, credentials });
          }}
          rows={5}
          placeholder={
            '{\n  "type": "service_account",\n  "project_id": "…",\n  "client_email": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----…"\n}'
          }
          submitLabel="Save"
          pendingLabel="Verifying…"
          pending={save.isPending}
          canSubmit={!!credentials}
          align="end"
        />
      )}
      <CredentialFeedback saveError={save.error?.message} result={result} />
    </div>
  );
}

// AWS Bedrock credentials shared by everyone working on this repo.
function RepoAwsSection({
  repoFullName,
  status,
  hideHeading,
}: {
  repoFullName: string;
  status?: {
    configured: boolean;
    accessKeyIdMasked?: string;
    region?: string;
    isTemporary?: boolean;
  };
  hideHeading?: boolean;
}) {
  const utils = api.useUtils();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCredentials.invalidate({ repoFullName }),
  );

  const save = api.webhooks.setAws.useMutation({
    onSuccess: () =>
      onSave(() => {
        setAccessKeyId("");
        setSecretAccessKey("");
        setSessionToken("");
      }),
  });
  const remove = api.webhooks.deleteAws.useMutation({ onSuccess: onRemove });

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
      {!hideHeading && (
        <h3 className="text-sm font-semibold text-orange-300">
          AWS Bedrock credentials
        </h3>
      )}
      {status?.configured ? (
        <MaskedCredentialRow
          onRemove={() => remove.mutate({ repoFullName })}
          removePending={remove.isPending}
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
      <CredentialFeedback saveError={save.error?.message} result={result} />
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
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCredentials.invalidate({ repoFullName }),
  );

  const save = api.webhooks.setArtifacts.useMutation({
    onSuccess: () =>
      onSave(() => {
        setBucket("");
        setEndpoint("");
        setAccessKeyId("");
        setSecretAccessKey("");
      }),
  });
  const remove = api.webhooks.deleteArtifacts.useMutation({
    onSuccess: onRemove,
  });

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-emerald-300">
        Run artifact storage (S3)
      </h3>
      <p className="text-xs text-white/40">
        A bucket this repo owns for persisted run transcripts. Without one, they
        vanish with the pod. Use credentials scoped to just this bucket — they
        stay on the server, never given to agents.
      </p>
      {status?.configured ? (
        <MaskedCredentialRow
          onRemove={() => remove.mutate({ repoFullName })}
          removePending={remove.isPending}
        >
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
        </MaskedCredentialRow>
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
      <CredentialFeedback saveError={save.error?.message} result={result} />
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
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCredentials.invalidate({ repoFullName }),
  );

  const save = api.webhooks.setKubeconfig.useMutation({
    onSuccess: (r) =>
      onSave(
        () => setKubeconfig(""),
        `Saved and verified ✓ ${r.version ?? ""}`,
      ),
  });
  const remove = api.webhooks.deleteKubeconfig.useMutation({
    onSuccess: onRemove,
  });

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-sky-300">Kubeconfig</h3>
      {configured ? (
        <MaskedCredentialRow
          onRemove={() => remove.mutate({ repoFullName })}
          removePending={remove.isPending}
        >
          <span className="text-white/70">A kubeconfig is configured.</span>
        </MaskedCredentialRow>
      ) : (
        <SecretForm
          accent="sky"
          variant="textarea"
          required
          value={kubeconfig}
          onChange={setKubeconfig}
          onSubmit={() => {
            setResult(null);
            save.mutate({ repoFullName, kubeconfig });
          }}
          rows={5}
          placeholder={
            "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://…"
          }
          submitLabel="Save & verify"
          pendingLabel="Verifying…"
          pending={save.isPending}
          canSubmit={!!kubeconfig}
          align="end"
        />
      )}
      <CredentialFeedback saveError={save.error?.message} result={result} />
    </div>
  );
}

// The repo's shared model-provider directory: the same tier-free card system as
// the user settings page, but scoped to the repo and wired to the webhooks
// router (admin-gated). The four rich providers reuse the repo sections above
// (as headingless card bodies); the ~90 gollm-proxied ones use the generic
// catalog form. `creds` is the already-loaded repo credential status.
function RepoProviderDirectory({
  repoFullName,
  creds,
}: {
  repoFullName: string;
  creds: RouterOutputs["webhooks"]["getCredentials"] | undefined;
}) {
  const utils = api.useUtils();
  const { data: catalog } = api.account.customProviderCatalog.useQuery();
  const { data: configured } = api.webhooks.getCustomProviders.useQuery({
    repoFullName,
  });

  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.webhooks.getCustomProviders.invalidate({ repoFullName }),
  );
  const setCustom = api.webhooks.setCustomProvider.useMutation({
    onSuccess: () => onSave(),
  });
  const deleteCustom = api.webhooks.deleteCustomProvider.useMutation({
    onSuccess: onRemove,
  });
  const testCustom = api.webhooks.testCustomProvider.useMutation({
    onSuccess: (r) => setResult(r.valid ? "Valid ✓" : `Invalid: ${r.error}`),
  });

  const configuredById = new Map(
    (configured ?? []).map((c) => [c.provider, c]),
  );

  const entries: ProviderEntry[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      accent: "purple",
      configured: !!creds?.anthropic.configured,
      keywords: "claude",
      priority: 100,
      body: (
        <RepoAnthropicSection
          repoFullName={repoFullName}
          status={creds?.anthropic}
          hideHeading
        />
      ),
    },
    {
      id: "openai",
      label: "OpenAI",
      accent: "teal",
      configured: !!creds?.openai.configured,
      keywords: "gpt chatgpt",
      priority: 90,
      body: (
        <RepoOpenAISection
          repoFullName={repoFullName}
          status={creds?.openai}
          hideHeading
        />
      ),
    },
    {
      id: "gemini",
      label: "Gemini",
      accent: "blue",
      configured: !!creds?.gemini.configured,
      keywords: "google vertex",
      priority: 80,
      body: (
        <RepoGeminiSection
          repoFullName={repoFullName}
          status={creds?.gemini}
          hideHeading
        />
      ),
    },
    {
      id: "bedrock",
      label: "AWS Bedrock",
      accent: "orange",
      configured: !!creds?.aws.configured,
      keywords: "aws amazon claude",
      priority: 70,
      body: (
        <RepoAwsSection
          repoFullName={repoFullName}
          status={creds?.aws}
          hideHeading
        />
      ),
    },
    ...(catalog ?? []).map(
      (c): ProviderEntry => ({
        id: c.id,
        label: c.label,
        accent: "sky",
        configured: configuredById.has(c.id),
        keywords: c.id,
        priority: c.priority,
        body: (
          <GenericProviderForm
            entry={c}
            configured={configuredById.get(c.id)}
            onSubmit={async (v) => {
              await setCustom.mutateAsync({
                repoFullName,
                provider: c.id,
                fields: v.fields,
                models: v.models,
              });
            }}
            savePending={setCustom.isPending}
            saveError={setCustom.error?.message}
            result={result}
            onTest={() => {
              setResult("Testing…");
              testCustom.mutate({ repoFullName, provider: c.id });
            }}
            testPending={testCustom.isPending}
            onRemove={() =>
              deleteCustom.mutate({ repoFullName, provider: c.id })
            }
            removePending={deleteCustom.isPending}
          />
        ),
      }),
    ),
  ];

  return (
    <ProviderDirectory
      entries={entries}
      intro={
        <p className="text-xs text-white/40">
          Model credentials shared across everyone who runs agents for this
          repo. Every provider Bandolier supports is here; configured ones
          appear in the deploy picker for collaborators (per the credential
          preference below).
        </p>
      }
    />
  );
}

// user-vs-repo preference toggle and a prominent security warning. Renders the
// whole "Shared credentials" settings panel — intro, warning, then one card
// per credential (the cards mount only once the status query resolves, so the
// forms never flash their empty state while it loads).
export function RepoCredentialsPanel({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const utils = api.useUtils();
  const { data: creds, isLoading } = api.webhooks.getCredentials.useQuery({
    repoFullName,
  });
  const setPrefer = api.webhooks.setPreferRepoCredentials.useMutation({
    onSuccess: () => utils.webhooks.getCredentials.invalidate({ repoFullName }),
  });

  return (
    <>
      <p className="text-xs text-white/40">
        A cluster and model credentials shared by everyone who runs agents for
        this repo (including webhook-triggered runs), so they don&apos;t each
        need their own. Only repo admins can change them. Without shared
        credentials, an agent triggered by a GitHub event runs with the
        credentials of the user who initiated it (e.g. the issue opener), so
        that user must be signed in to Bandolier with model and cluster
        credentials configured.
      </p>

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
          <SettingsCard id="kubeconfig">
            <RepoKubeconfigSection
              repoFullName={repoFullName}
              configured={creds?.hasKubeconfig ?? false}
            />
          </SettingsCard>
          <SettingsCard id="providers">
            <RepoProviderDirectory repoFullName={repoFullName} creds={creds} />
          </SettingsCard>
          <SettingsCard id="artifacts">
            <RepoArtifactsSection
              repoFullName={repoFullName}
              status={creds?.artifacts}
            />
          </SettingsCard>

          {/* Prefer user vs repo credentials. */}
          <SettingsCard id="preference">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-white/80">
                Credential preference
              </h3>
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
                  onClick={() =>
                    setPrefer.mutate({ repoFullName, prefer: true })
                  }
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
                The other side is still used as a fallback when the preferred
                one isn&apos;t configured.
              </p>
              {setPrefer.error && (
                <p className="text-xs text-red-400">
                  {setPrefer.error.message}
                </p>
              )}
            </div>
          </SettingsCard>
        </>
      )}
    </>
  );
}
