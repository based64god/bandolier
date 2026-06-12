"use client";

import { useEffect, useState } from "react";

import { buildIssuePrompt, issuePreviewBranch } from "~/lib/issue-prompt";
import { api } from "~/trpc/react";
import { SearchableSelect } from "./searchable-select";

const PROVIDER_LABELS = {
  anthropic: {
    label: "Anthropic API",
    style: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  },
  bedrock: {
    label: "AWS Bedrock",
    style: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  },
  none: {
    label: "No provider configured",
    style: "border-red-500/40 bg-red-500/10 text-red-400",
  },
} as const;

export function DeployModal({
  onClose,
  namespace,
  repoFullName,
  defaultRepoUrl,
  defaultBranch,
}: {
  onClose: () => void;
  namespace: string;
  repoFullName?: string;
  defaultRepoUrl?: string;
  defaultBranch?: string;
}) {
  const [task, setTask] = useState("");
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl ?? "");
  const [branch, setBranch] = useState(defaultBranch ?? "main");
  // Empty string means "use the default"; the effective model is derived below.
  const [model, setModel] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  // "" means no issue selected.
  const [issueNumber, setIssueNumber] = useState("");
  // Interactive agents stay alive and wait for the user's input between turns.
  const [interactive, setInteractive] = useState(false);

  const { data: providerInfo } = api.agents.providerInfo.useQuery();
  const { data: deployDefaults } = api.agents.deployDefaults.useQuery();
  const defaultMaxTurns = deployDefaults?.maxTurns;
  const { data: issues = [], isLoading: issuesLoading } =
    api.repos.issues.useQuery(
      { repoFullName: repoFullName! },
      { enabled: !!repoFullName },
    );
  const {
    data: modelData,
    isLoading: modelsLoading,
    error: modelsError,
  } = api.models.list.useQuery();
  const models = modelData?.models ?? [];

  const hasIssue = issueNumber !== "";
  const selectedIssue = hasIssue
    ? (issues.find((i) => String(i.number) === issueNumber) ?? null)
    : null;

  // Derive the effective model (no effect needed): an explicit choice, else a
  // Sonnet, else the first available.
  const defaultModel =
    models.find((m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label))?.id ??
    models[0]?.id ??
    "";
  const effectiveModel = model || defaultModel;

  const utils = api.useUtils();
  const deploy = api.agents.deploy.useMutation({
    onSuccess: () => {
      void utils.agents.list.invalidate({ namespace });
      onClose();
    },
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    deploy.mutate({
      namespace,
      task,
      repoUrl: repoUrl || undefined,
      repoFullName,
      branch,
      model: effectiveModel,
      maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
      issueNumber: hasIssue ? parseInt(issueNumber, 10) : undefined,
      interactive: interactive || undefined,
    });
  }

  const provider = providerInfo?.provider ?? "none";
  const providerMeta = PROVIDER_LABELS[provider];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-white/20 bg-[#0a0a1a]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">Deploy Agent</h2>
            {providerInfo && (
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${providerMeta.style}`}
              >
                {providerMeta.label}
                {providerInfo.provider === "bedrock" && providerInfo.region
                  ? ` · ${providerInfo.region}`
                  : ""}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          {/* No-provider warning */}
          {providerInfo?.provider === "none" && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              No model provider is configured. Add an Anthropic API key or AWS
              Bedrock credentials in settings before deploying.
            </p>
          )}

          {/* Model-loading error (e.g. expired credentials) */}
          {modelsError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <p className="font-semibold">Couldn’t load models</p>
              <p className="mt-1 text-red-400/90">{modelsError.message}</p>
              <p className="mt-1 text-red-400/70">
                Check your provider credentials in settings — they may be
                invalid or expired.
              </p>
            </div>
          )}

          {/* GitHub issue (optional) */}
          {repoFullName && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label className="block text-xs font-medium text-white/60">
                  GitHub issue{" "}
                  <span className="font-normal text-white/30">(optional)</span>
                </label>
                {selectedIssue && (
                  <span className="group relative flex">
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="h-3.5 w-3.5 cursor-help text-white/40 hover:text-white/70"
                      aria-label="Preview context sent to Claude"
                    >
                      <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
                    </svg>
                    <div className="invisible absolute top-5 left-0 z-30 w-96 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100">
                      <div className="max-h-72 overflow-auto rounded-lg border border-white/10 bg-[#0d0d20] p-3 shadow-2xl">
                        <p className="mb-1.5 text-[10px] font-medium tracking-wider text-white/40 uppercase">
                          Context sent to Claude
                        </p>
                        <pre className="font-mono text-[11px] leading-4 whitespace-pre-wrap text-white/60">
                          {buildIssuePrompt(
                            selectedIssue,
                            issuePreviewBranch(
                              selectedIssue.number,
                              selectedIssue.title,
                            ),
                            task,
                          )}
                        </pre>
                      </div>
                    </div>
                  </span>
                )}
              </div>
              <SearchableSelect
                options={issues.map((i) => ({
                  value: String(i.number),
                  searchText: `#${i.number} ${i.title}`.toLowerCase(),
                  label: (
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-white/40">#{i.number}</span>{" "}
                      <span className="text-white">{i.title}</span>
                    </span>
                  ),
                }))}
                value={issueNumber || null}
                onChange={(v) => setIssueNumber(v ?? "")}
                placeholder="No issue — freeform task"
                clearLabel="No issue — freeform task"
                loading={issuesLoading}
                searchPlaceholder="Search issues…"
                emptyText="No open issues in this repository."
              />
              {hasIssue && (
                <p className="text-xs text-white/40">
                  The agent gets the issue details as context and opens a PR
                  that closes it. The task below is optional extra context.
                </p>
              )}
            </div>
          )}

          {/* Task */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-white/60">
              {hasIssue ? (
                <>
                  Additional context{" "}
                  <span className="font-normal text-white/30">(optional)</span>
                </>
              ) : (
                <>
                  Task <span className="text-red-400">*</span>
                </>
              )}
            </label>
            <textarea
              required={!hasIssue}
              rows={5}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={
                hasIssue
                  ? "Extra guidance for the agent (optional)…"
                  : "Describe what you want Claude to do…"
              }
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
            />
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-white/60">
              Model
            </label>
            <select
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              disabled={modelsLoading || models.length === 0}
              className="w-full cursor-pointer rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-purple-500/50 focus:outline-none disabled:opacity-50"
            >
              {modelsLoading && <option>Loading models…</option>}
              {modelsError && <option>Failed to load models</option>}
              {!modelsLoading && !modelsError && models.length === 0 && (
                <option>No models available</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-[#0a0a1a]">
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Repo + Branch */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Repository URL
              </label>
              <input
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-white/60">
                Branch
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
          </div>

          {/* Max turns */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-white/60">
              Max turns{" "}
              {defaultMaxTurns !== undefined && (
                <span className="font-normal text-white/30">
                  (default: {defaultMaxTurns})
                </span>
              )}
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              disabled={interactive}
              placeholder={
                defaultMaxTurns !== undefined ? String(defaultMaxTurns) : ""
              }
              className="w-32 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none disabled:opacity-40"
            />
          </div>

          {/* Interactive */}
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={interactive}
              onChange={(e) => setInteractive(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-purple-600"
            />
            <span className="text-xs text-white/60">
              <span className="font-medium text-white/80">
                Interactive session
              </span>
              <span className="mt-0.5 block text-white/40">
                Keep the agent running and chat with it — it pauses for your
                input between turns and alerts you when it&rsquo;s waiting. Turn
                cap doesn&rsquo;t apply.
              </span>
            </span>
          </label>

          {/* Deploy error */}
          {deploy.error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {deploy.error.message}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                deploy.isPending ||
                !effectiveModel ||
                (!hasIssue && !task.trim())
              }
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deploy.isPending ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
