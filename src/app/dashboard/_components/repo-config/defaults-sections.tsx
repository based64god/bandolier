"use client";

import { useState } from "react";

import { EFFORT_LEVELS, providerSupportsEffort } from "~/lib/effort";
import { api } from "~/trpc/react";
import { CredentialFeedback } from "../credential-ui";
import { ProviderTag } from "../provider-tag";
import { SearchableSelect } from "../searchable-select";

// Default model for webhook-triggered agents on this repo, chosen from the models
// the admin's + repo's credentials unlock. Saved immediately on selection.
export function RepoDefaultModelSection({
  repoFullName,
}: {
  repoFullName: string;
}) {
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
      <CredentialFeedback
        saveError={setDefault.error?.message}
        result={result}
      />
    </div>
  );
}

// Default reasoning effort for webhook-triggered Claude agents on this repo.
// Claude-only (Anthropic / Bedrock): hidden when the repo's configured provider
// can't use it. An issue `effort:<level>` label overrides it per issue.
export function RepoDefaultEffortSection({
  repoFullName,
}: {
  repoFullName: string;
}) {
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
      <CredentialFeedback
        saveError={setDefault.error?.message}
        result={result}
      />
    </div>
  );
}

// Default agent compute (CPU / memory limit) for every run on this repo —
// dashboard, issue, and webhook alike. Ordered against a user's own default by
// the prefer-repo-credentials toggle; a per-task override (deploy form, or an
// issue `cpu:`/`memory:` label) beats both.
export function RepoDefaultComputeSection({
  repoFullName,
}: {
  repoFullName: string;
}) {
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
      <CredentialFeedback
        saveError={setDefault.error?.message}
        result={result}
      />
    </div>
  );
}
