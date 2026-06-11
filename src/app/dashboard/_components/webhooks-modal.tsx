"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";

export function WebhooksModal({
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
  // Uncontrolled so it can pick up the saved value on load without a syncing
  // effect; read via the ref on submit.
  const prefixRef = useRef<HTMLInputElement>(null);

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
            <h2 className="text-sm font-semibold text-white">Webhooks</h2>
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
            Configure a GitHub webhook so events in this repository can trigger
            agents. Set a secret here, then add the webhook in GitHub using the
            details below.
          </p>

          {/* Current status */}
          {!isLoading && config?.configured && (
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
                    config?.configured
                      ? "Leave blank to keep current secret"
                      : "Secret"
                  }
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={
                    save.isPending ||
                    (secret.length > 0 && secret.length < 8) ||
                    (!config?.configured && secret.length === 0)
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
              credentials configured.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
