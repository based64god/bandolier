"use client";

import { useState, useSyncExternalStore } from "react";

import { CredentialFeedback } from "~/app/dashboard/_components/credential-ui";
import { api } from "~/trpc/react";

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

export function ApiKeysSection() {
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
    <div className="space-y-3">
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
