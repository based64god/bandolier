"use client";

import { useEffect, useRef, useState } from "react";

import {
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  issuePreviewBranch,
} from "~/lib/issue-prompt";
import { type EffortLevel, providerSupportsEffort } from "~/lib/effort";
import { api } from "~/trpc/react";
import { EffortPicker } from "./effort-picker";
import { usePreferredEffort } from "./preferred-effort";
import { usePreferredModel } from "./preferred-model";
import { ProviderTag } from "./provider-tag";
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
  openai: {
    label: "OpenAI API",
    style: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  },
  gemini: {
    label: "Google Gemini",
    style: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  },
  none: {
    label: "No provider configured",
    style: "border-red-500/40 bg-red-500/10 text-red-400",
  },
} as const;

// Picker option key. A model can be offered once per credential kind (a user
// with both an API key and a subscription sees e.g. "claude-opus-4-8" twice),
// so options are keyed by id + auth rather than the bare id.
function modelKey(m: { id: string; auth?: string }): string {
  return m.auth ? `${m.id}::${m.auth}` : m.id;
}

export function DeployModal({
  onClose,
  onDeployed,
  namespace,
  repoFullName,
  defaultRepoUrl,
  defaultBranch,
}: {
  onClose: () => void;
  // Fired once the deploy succeeds, with the created job's name and a display
  // label, so the dashboard can show an optimistic "Deploying" row until the
  // pod actually surfaces in the cluster's pod list.
  onDeployed?: (task: { jobName: string; displayName: string }) => void;
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
  // Empty string means "use the CLI default" reasoning effort.
  const [effort, setEffort] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  // Per-task compute (CPU / memory limit) overrides; "" uses the resolved
  // repo/user default shown as the placeholder.
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  // "" means no issue selected.
  const [issueNumber, setIssueNumber] = useState("");
  // Interactive agents stay alive and wait for the user's input between turns.
  const [interactive, setInteractive] = useState(false);
  // "pr" opens a pull request; "issue" opens a GitHub issue (sub-task) from the
  // agent's findings. Issue output needs a repository to open the issue in.
  const [outputType, setOutputType] = useState<"pr" | "issue">("pr");
  const issueOutput = outputType === "issue";

  // Context-preview tooltip. Hover shows it; clicking the info button "pins" it
  // open so the user can scroll/select inside without it closing on mouse-out.
  const [contextPinned, setContextPinned] = useState(false);
  const [contextHovered, setContextHovered] = useState(false);
  const contextRef = useRef<HTMLSpanElement>(null);
  // Tracks whether the current mouse gesture began on the backdrop, so a drag
  // that ends outside the modal doesn't count as a backdrop click.
  const backdropMouseDown = useRef(false);
  const showContext = contextPinned || contextHovered;

  const { data: providerInfo } = api.agents.providerInfo.useQuery({
    repoFullName,
  });
  const { data: deployDefaults } = api.agents.deployDefaults.useQuery({
    repoFullName,
  });
  const defaultMaxTurns = deployDefaults?.maxTurns;
  const defaultCompute = deployDefaults?.compute;
  const { data: issues = [], isLoading: issuesLoading } =
    api.repos.issues.useQuery(
      { repoFullName: repoFullName! },
      { enabled: !!repoFullName },
    );
  const {
    data: modelData,
    isLoading: modelsLoading,
    error: modelsError,
  } = api.models.list.useQuery({ repoFullName });
  const models = modelData?.models ?? [];

  // Per-browser preferred model. Used purely as a dashboard default; never sent
  // to the server, so webhook-spawned tasks are unaffected.
  const [preferredModel, setPreferredModel] = usePreferredModel();
  // Per-browser preferred reasoning effort — same dashboard-only role.
  const [preferredEffort, setPreferredEffort] = usePreferredEffort();

  const hasIssue = issueNumber !== "";
  const selectedIssue = hasIssue
    ? (issues.find((i) => String(i.number) === issueNumber) ?? null)
    : null;

  // Derive the effective model (no effect needed): an explicit choice, else the
  // user's preferred model (if still available), else a Sonnet, else the first
  // available. Selection state holds the option KEY (id + credential kind), not
  // the bare id — the same model can be offered once per credential kind, and
  // the key disambiguates "run on my API key" from "run on my subscription".
  // A legacy stored preference may be a bare id; resolve it by id as a fallback.
  const preferredOption =
    models.find((m) => modelKey(m) === preferredModel) ??
    models.find((m) => m.id === preferredModel);
  const fallbackOption =
    models.find((m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label)) ??
    models[0];
  const defaultModel = preferredOption
    ? modelKey(preferredOption)
    : fallbackOption
      ? modelKey(fallbackOption)
      : "";
  const effectiveModel = model || defaultModel;
  const selectedModel =
    models.find((m) => modelKey(m) === effectiveModel) ?? null;
  const isPreferred =
    !!selectedModel &&
    (modelKey(selectedModel) === preferredModel ||
      selectedModel.id === preferredModel);

  // Reasoning effort only applies to Claude models (Anthropic / Bedrock). Hide
  // the picker for OpenAI/Gemini and never send a value for them. Default to the
  // browser's preferred effort; "" means the CLI default.
  const effortSupported = selectedModel
    ? providerSupportsEffort(selectedModel.provider)
    : false;
  const effectiveEffort = effort || preferredEffort;
  const isPreferredEffort =
    !!effectiveEffort && effectiveEffort === preferredEffort;

  const utils = api.useUtils();
  const deploy = api.agents.deploy.useMutation({
    onSuccess: (data) => {
      void utils.agents.list.invalidate({ namespace });
      // Mirror what the task cell will render for the real row (see
      // taskNameLabel): the issue label, else the full task text — the row's
      // CSS truncates it to the column width. Lets the dashboard's optimistic
      // row read like the real one that replaces it.
      const displayName = selectedIssue
        ? `#${selectedIssue.number}: ${selectedIssue.title}`
        : task;
      onDeployed?.({ jobName: data.jobName, displayName });
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

  // Lock background scrolling while the modal is open so only the form scrolls.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Clicking outside a pinned context tooltip dismisses it.
  useEffect(() => {
    if (!contextPinned) return;
    const handler = (e: MouseEvent) => {
      if (!contextRef.current?.contains(e.target as Node)) {
        setContextPinned(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextPinned]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    deploy.mutate({
      namespace,
      task,
      repoUrl: repoUrl || undefined,
      repoFullName,
      branch,
      model: selectedModel?.id ?? effectiveModel.split("::")[0]!,
      modelProvider: selectedModel?.provider,
      modelAuth: selectedModel?.auth,
      effort:
        effortSupported && effectiveEffort
          ? (effectiveEffort as EffortLevel)
          : undefined,
      maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
      cpu: cpu.trim() || undefined,
      memory: memory.trim() || undefined,
      issueNumber: hasIssue ? parseInt(issueNumber, 10) : undefined,
      interactive: interactive || undefined,
      outputType: issueOutput ? "issue" : undefined,
    });
  }

  // Badge reflects the selected model's provider so it's clear what this deploy
  // will run on; falls back to the account's primary provider before a model
  // loads. Subscription-backed selections say so instead of "… API".
  const badgeProvider =
    selectedModel?.provider ?? providerInfo?.provider ?? "none";
  const providerMeta =
    selectedModel?.auth === "subscription"
      ? {
          ...PROVIDER_LABELS[badgeProvider],
          label:
            badgeProvider === "openai"
              ? "ChatGPT subscription"
              : "Claude subscription",
        }
      : PROVIDER_LABELS[badgeProvider];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      // Only close when the press *starts* on the backdrop. A click whose
      // mousedown began inside the modal (e.g. selecting text and releasing
      // outside) shares the backdrop as its common ancestor and would
      // otherwise close the modal.
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) onClose();
      }}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">Deploy Agent</h2>
            {providerInfo && (
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${providerMeta.style}`}
              >
                {providerMeta.label}
                {badgeProvider === "bedrock" && providerInfo.region
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

        <form
          onSubmit={handleSubmit}
          className="space-y-3 overflow-y-auto px-4 py-3"
        >
          {/* No-provider warning */}
          {providerInfo?.provider === "none" && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              No provider configured. Add an Anthropic, OpenAI, or Bedrock
              credential in settings first.
            </p>
          )}

          {/* Model-loading error (e.g. expired credentials) */}
          {modelsError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <p className="font-semibold">Couldn’t load models</p>
              <p className="mt-1 text-red-400/90">{modelsError.message}</p>
              <p className="mt-1 text-red-400/70">
                Check your provider credentials in settings.
              </p>
            </div>
          )}

          {/* GitHub issue (optional) */}
          {repoFullName && (
            <div className="space-y-1">
              <div className="relative flex items-center gap-1.5">
                <label className="block text-xs font-medium text-white/60">
                  GitHub issue{" "}
                  <span className="font-normal text-white/30">(optional)</span>
                </label>
                {selectedIssue && (
                  <span
                    ref={contextRef}
                    className="flex"
                    onMouseEnter={() => setContextHovered(true)}
                    onMouseLeave={() => setContextHovered(false)}
                  >
                    <button
                      type="button"
                      onClick={() => setContextPinned((p) => !p)}
                      className="flex text-white/40 hover:text-white/70"
                      aria-label="Preview context sent to Claude"
                      aria-expanded={showContext}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="h-3.5 w-3.5"
                      >
                        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
                      </svg>
                    </button>
                    {showContext && (
                      <div className="absolute top-full right-0 left-0 z-30 mt-1">
                        <div className="max-h-72 overflow-auto rounded-lg border border-white/10 bg-[var(--surface-panel)] p-3 shadow-2xl">
                          <p className="mb-1.5 text-[10px] font-medium tracking-wider text-white/40 uppercase">
                            System prompt
                          </p>
                          <pre className="mb-3 font-mono text-[11px] leading-4 whitespace-pre-wrap text-white/60">
                            {buildIssueSystemPrompt(
                              selectedIssue,
                              issuePreviewBranch(
                                selectedIssue.number,
                                selectedIssue.title,
                              ),
                            )}
                          </pre>
                          <p className="mb-1.5 text-[10px] font-medium tracking-wider text-white/40 uppercase">
                            Context sent to Claude
                          </p>
                          <pre className="font-mono text-[11px] leading-4 whitespace-pre-wrap text-white/60">
                            {buildIssueUserMessage(selectedIssue, task)}
                          </pre>
                        </div>
                      </div>
                    )}
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
                  {issueOutput
                    ? "Opens a sub-task issue (Part of #" +
                      selectedIssue?.number +
                      ") from its findings."
                    : "Opens a PR that closes this issue."}
                </p>
              )}
            </div>
          )}

          {/* Output type — what the run produces (needs a repository) */}
          {repoFullName && (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-white/60">
                Output
              </label>
              <div className="flex gap-2">
                {(
                  [
                    { value: "pr", label: "Pull request" },
                    { value: "issue", label: "GitHub issue" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setOutputType(opt.value)}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-sm transition ${
                      outputType === opt.value
                        ? "border-purple-500/50 bg-purple-500/15 text-white"
                        : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-white/40">
                {issueOutput
                  ? "Explores read-only and opens an issue — no code changes."
                  : "Implements the task and opens a pull request."}
              </p>
            </div>
          )}

          {/* Task */}
          <div className="space-y-1">
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
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={
                hasIssue
                  ? "Extra guidance for the agent (optional)…"
                  : "Describe what you want Claude to do…"
              }
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
            />
          </div>

          {/* Model */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-white/60">
              Model
            </label>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  options={models.map((m) => ({
                    value: modelKey(m),
                    searchText:
                      `${m.label} ${m.id} ${m.provider} ${m.auth ?? ""}`.toLowerCase(),
                    label: (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span className="truncate text-white">{m.label}</span>
                        <ProviderTag provider={m.provider} auth={m.auth} />
                      </span>
                    ),
                  }))}
                  value={effectiveModel || null}
                  onChange={(v) => setModel(v ?? "")}
                  placeholder="Select a model"
                  loading={modelsLoading}
                  disabled={!modelsLoading && models.length === 0}
                  searchPlaceholder="Search models…"
                  emptyText={
                    modelsError
                      ? "Failed to load models."
                      : "No models available — configure a provider in settings."
                  }
                />
              </div>
              <label
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                  isPreferred
                    ? "border-purple-500/50 bg-purple-500/15 text-white"
                    : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                } ${!effectiveModel ? "cursor-not-allowed opacity-40" : ""}`}
                title="Use this model as the default when deploying from the dashboard. Doesn't affect webhook-triggered tasks."
              >
                <input
                  type="checkbox"
                  checked={isPreferred}
                  disabled={!effectiveModel}
                  onChange={(e) =>
                    setPreferredModel(e.target.checked ? effectiveModel : "")
                  }
                  className="h-3.5 w-3.5 cursor-pointer accent-purple-600"
                />
                Preferred
              </label>
            </div>
            <p className="text-xs text-white/40">
              Preferred model is the dashboard default; webhooks aren&rsquo;t
              affected.
            </p>
          </div>

          {/* Reasoning effort — Claude models only (Anthropic / Bedrock). Hidden
              for OpenAI/Gemini, whose CLIs don't take an effort level. */}
          {effortSupported && (
            <EffortPicker
              value={effectiveEffort}
              onChange={setEffort}
              preferred
              isPreferred={isPreferredEffort}
              onTogglePreferred={(next) =>
                setPreferredEffort(next ? effectiveEffort : "")
              }
            />
          )}

          {/* Repo + Branch */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="block text-xs font-medium text-white/60">
                Repository URL
              </label>
              <input
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-white/60">
                Branch
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
          </div>

          {/* Max turns + compute (CPU / memory limit) overrides */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-white/60">
                Max turns
              </label>
              <input
                type="number"
                min={1}
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                disabled={interactive}
                placeholder={
                  defaultMaxTurns === undefined
                    ? ""
                    : defaultMaxTurns >= Number.MAX_SAFE_INTEGER
                      ? "unlimited"
                      : String(defaultMaxTurns)
                }
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none disabled:opacity-40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-white/60">
                CPU
              </label>
              <input
                type="text"
                value={cpu}
                onChange={(e) => setCpu(e.target.value)}
                placeholder={defaultCompute?.cpu ?? ""}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-white/60">
                Memory
              </label>
              <input
                type="text"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                placeholder={defaultCompute?.memory ?? ""}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
              />
            </div>
          </div>
          <p className="-mt-1 text-xs text-white/40">
            Placeholders show the defaults. Quantities like{" "}
            <code className="text-white/50">4</code> and{" "}
            <code className="text-white/50">8Gi</code>.
          </p>

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
                Keep the agent running and chat with it between turns. Turn cap
                doesn&rsquo;t apply.
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
              className="rounded-lg bg-white/10 px-4 py-1.5 text-sm hover:bg-white/20"
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
              className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deploy.isPending ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
