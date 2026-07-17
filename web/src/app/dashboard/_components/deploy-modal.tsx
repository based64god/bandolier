"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

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
import { Modal } from "./modal";
import { ProviderTag } from "./provider-tag";
import { modelKey, resolveEffectiveModel } from "./resolve-effective-model";
import { SearchableSelect } from "./searchable-select";

// The deploy form's fields as a single value. "" means "use the default" for
// the derived/optional fields (model, effort, maxTurns, cpu, memory,
// issueNumber). Collapsing these into one reducer keeps submit mapping a single
// state value rather than a dozen scattered useState setters.
interface DeployForm {
  task: string;
  repoUrl: string;
  branch: string;
  // Empty string means "use the default"; the effective model is derived below.
  model: string;
  // Empty string means "use the CLI default" reasoning effort.
  effort: string;
  maxTurns: string;
  // Per-task compute (CPU / memory limit) overrides; "" uses the resolved
  // repo/user default shown as the placeholder.
  cpu: string;
  memory: string;
  // "" means no issue selected.
  issueNumber: string;
  // Interactive agents stay alive and wait for the user's input between turns.
  interactive: boolean;
  // "pr" opens a pull request; "issue" opens a GitHub issue (sub-task) from the
  // agent's findings; "review" reviews a pull request (reviewPrNumber). Issue
  // and review output need a repository.
  outputType: "pr" | "issue" | "review";
  // The pull request number a "review" run reviews. Empty unless output=review.
  reviewPrNumber: string;
}

type DeployFormAction = {
  [K in keyof DeployForm]: { field: K; value: DeployForm[K] };
}[keyof DeployForm];

function deployFormReducer(
  state: DeployForm,
  action: DeployFormAction,
): DeployForm {
  return { ...state, [action.field]: action.value };
}

// Context-preview tooltip. Hover shows it; clicking the info button "pins" it
// open so the user can scroll/select inside without it closing on mouse-out.
// Clicking outside a pinned tooltip dismisses it.
function PinnedTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const open = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [pinned]);

  return (
    <span
      ref={ref}
      className="flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        className="flex text-white/40 hover:text-white/70"
        aria-label={label}
        aria-expanded={open}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
          <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a1 1 0 0 1 1 1v3a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1Zm0 7.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1">
          {children}
        </div>
      )}
    </span>
  );
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
  const [form, setField] = useReducer(deployFormReducer, {
    task: "",
    repoUrl: defaultRepoUrl ?? "",
    branch: defaultBranch ?? "main",
    model: "",
    effort: "",
    maxTurns: "",
    cpu: "",
    memory: "",
    issueNumber: "",
    interactive: false,
    outputType: "pr",
    reviewPrNumber: "",
  });
  const {
    task,
    repoUrl,
    branch,
    model,
    effort,
    maxTurns,
    cpu,
    memory,
    issueNumber,
    interactive,
    outputType,
    reviewPrNumber,
  } = form;
  const issueOutput = outputType === "issue";
  const reviewOutput = outputType === "review";
  // A review is deployable once a PR number is entered — it needs no task.
  const reviewValid = reviewOutput && reviewPrNumber.trim() !== "";

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

  // gollm-proxied providers share one badge; their label comes from the
  // catalog, keyed by the `gollm:<id>` provider name the picker uses.
  const { data: providerCatalog } =
    api.account.customProviderCatalog.useQuery();
  const providerLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of providerCatalog ?? []) map[`gollm:${c.id}`] = c.label;
    return map;
  }, [providerCatalog]);

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
  // user's preferred model, else a Sonnet, else the first available.
  const {
    effectiveKey: effectiveModel,
    selected: selectedModel,
    isPreferred,
    submitId: submitModelId,
  } = resolveEffectiveModel(models, model, preferredModel);

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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    deploy.mutate({
      namespace,
      task,
      repoUrl: repoUrl || undefined,
      repoFullName,
      branch,
      model: submitModelId,
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
      // A review is always one-shot.
      interactive: reviewOutput ? undefined : interactive || undefined,
      outputType: reviewOutput ? "review" : issueOutput ? "issue" : undefined,
      reviewPrNumber: reviewValid
        ? parseInt(reviewPrNumber, 10)
        : undefined,
    });
  }

  return (
    <Modal
      onClose={onClose}
      title="Deploy Agent"
      headerClassName="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5"
    >
      <form
        onSubmit={handleSubmit}
        className="space-y-2 overflow-y-auto px-3 py-2 sm:space-y-3 sm:px-4 sm:py-3"
      >
        {/* No-provider warning */}
        {providerInfo?.provider === "none" && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            No provider configured. Add a model provider credential in settings
            first.
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

        {/* GitHub issue (optional) — not shown for a PR review */}
        {repoFullName && !reviewOutput && (
          <div className="space-y-1">
            <div className="relative flex items-center gap-1.5">
              <label className="block text-xs font-medium text-white/60">
                GitHub issue{" "}
                <span className="font-normal text-white/30">(optional)</span>
              </label>
              {selectedIssue && (
                <PinnedTooltip label="Preview context sent to Claude">
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
                </PinnedTooltip>
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
              onChange={(v) =>
                setField({ field: "issueNumber", value: v ?? "" })
              }
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
                  { value: "review", label: "PR review" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    setField({ field: "outputType", value: opt.value })
                  }
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
                : reviewOutput
                  ? "Reviews a pull request read-only. The review is posted as you."
                  : "Implements the task and opens a pull request."}
            </p>
            {reviewOutput && (
              <input
                type="number"
                min={1}
                value={reviewPrNumber}
                onChange={(e) =>
                  setField({ field: "reviewPrNumber", value: e.target.value })
                }
                placeholder="Pull request number (e.g. 42)"
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-purple-500/50 focus:outline-none"
              />
            )}
          </div>
        )}

        {/* Task — a review's input is the PR, so no task is needed for it */}
        {!reviewOutput && (
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
              onChange={(e) =>
                setField({ field: "task", value: e.target.value })
              }
              placeholder={
                hasIssue
                  ? "Extra guidance for the agent (optional)…"
                  : "Describe what you want Claude to do…"
              }
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
            />
          </div>
        )}

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
                      <ProviderTag
                        provider={m.provider}
                        auth={m.auth}
                        label={providerLabels?.[m.provider]}
                      />
                    </span>
                  ),
                }))}
                value={effectiveModel || null}
                onChange={(v) => setField({ field: "model", value: v ?? "" })}
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
          <p className="hidden text-xs text-white/40 sm:block">
            Preferred model is the dashboard default; webhooks aren&rsquo;t
            affected.
          </p>
        </div>

        {/* Reasoning effort — Claude models only (Anthropic / Bedrock). Hidden
              for OpenAI/Gemini, whose CLIs don't take an effort level. */}
        {effortSupported && (
          <EffortPicker
            value={effectiveEffort}
            onChange={(v) => setField({ field: "effort", value: v })}
            preferred
            isPreferred={isPreferredEffort}
            onTogglePreferred={(next) =>
              setPreferredEffort(next ? effectiveEffort : "")
            }
          />
        )}

        {/* Repo + Branch */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <label className="block text-xs font-medium text-white/60">
              Repository URL
            </label>
            <input
              type="url"
              value={repoUrl}
              onChange={(e) =>
                setField({ field: "repoUrl", value: e.target.value })
              }
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
              onChange={(e) =>
                setField({ field: "branch", value: e.target.value })
              }
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
              onChange={(e) =>
                setField({ field: "maxTurns", value: e.target.value })
              }
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
              onChange={(e) =>
                setField({ field: "cpu", value: e.target.value })
              }
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
              onChange={(e) =>
                setField({ field: "memory", value: e.target.value })
              }
              placeholder={defaultCompute?.memory ?? ""}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
            />
          </div>
        </div>
        <p className="-mt-1 hidden text-xs text-white/40 sm:block">
          Placeholders show the defaults. Quantities like{" "}
          <code className="text-white/50">4</code> and{" "}
          <code className="text-white/50">8Gi</code>.
        </p>

        {/* Interactive */}
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={interactive}
            onChange={(e) =>
              setField({ field: "interactive", value: e.target.checked })
            }
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
              (reviewOutput
                ? !reviewValid
                : !hasIssue && !task.trim())
            }
            className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deploy.isPending ? "Deploying…" : "Deploy"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
