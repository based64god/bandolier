"use client";

import { useRef, useState } from "react";

import { env } from "~/env";
import { api } from "~/trpc/react";

// The GitHub App install pointer: event delivery is handled by the Bandolier
// GitHub App, so this card replaces any hand-configured webhook guidance.
export function GithubAppSection({ repoFullName }: { repoFullName: string }) {
  // The GitHub App install page; null when no slug is configured (self-hosters
  // who haven't set NEXT_PUBLIC_GITHUB_APP_SLUG), in which case we show generic
  // guidance instead of a broken link.
  const installUrl = env.NEXT_PUBLIC_GITHUB_APP_SLUG;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-purple-300">
        Install the GitHub App
      </h3>
      <p className="text-xs text-white/60">
        The Bandolier GitHub App delivers issue and pull-request events and
        posts updates as the bot. Installing it on{" "}
        <code className="text-white/80">{repoFullName}</code> wires up event
        delivery automatically — there is no webhook secret to manage.
      </p>
      {installUrl ? (
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500"
        >
          Install or configure on GitHub
        </a>
      ) : (
        <p className="text-[11px] text-white/30">
          Ask your Bandolier admin for the GitHub App install link (set{" "}
          <code className="text-white/50">NEXT_PUBLIC_GITHUB_APP_SLUG</code> to
          surface it here).
        </p>
      )}
    </div>
  );
}

// The trigger prefix, agent image, and repository system prompt — one form,
// saved together (they share the setConfig mutation).
export function RepoBehaviorSection({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const [result, setResult] = useState<string | null>(null);
  // Uncontrolled so they pick up the saved value on load without a syncing
  // effect; read via the refs on submit.
  const prefixRef = useRef<HTMLInputElement>(null);
  const agentImageRef = useRef<HTMLInputElement>(null);
  const systemPromptRef = useRef<HTMLTextAreaElement>(null);

  const utils = api.useUtils();
  const { data: config } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });

  const save = api.webhooks.setConfig.useMutation({
    onSuccess: () => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setResult("Saved ✓");
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        save.mutate({
          repoFullName,
          prefix: prefixRef.current?.value ?? "",
          agentImage: agentImageRef.current?.value ?? "",
          systemPrompt: systemPromptRef.current?.value ?? "",
        });
      }}
      className="space-y-4"
    >
      <h3 className="text-sm font-semibold text-purple-300">
        Triggers &amp; behavior
      </h3>

      {/* Trigger prefix */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-white/60">
          Trigger prefix{" "}
          <span className="font-normal text-white/30">(optional)</span>
        </label>
        <input
          key={config ? `prefix-${String(config.updatedAt)}` : "prefix-loading"}
          ref={prefixRef}
          type="text"
          defaultValue={config?.prefix ?? ""}
          placeholder="e.g. @bando"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
        />
        <p className="text-xs text-white/30">
          When set, only events whose title or body contains this text trigger
          an agent. Leave blank to act on all events.
        </p>
      </div>

      {/* Agent image */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-white/60">
          Agent image{" "}
          <span className="font-normal text-white/30">(optional)</span>
        </label>
        <input
          key={config ? `image-${String(config.updatedAt)}` : "image-loading"}
          ref={agentImageRef}
          type="text"
          defaultValue={config?.agentImage ?? ""}
          placeholder="e.g. ghcr.io/based64god/bandolier-agent-harness:latest"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
        />
        <p className="text-xs text-white/30">
          Container image agents for this repo run on. Leave blank to use the
          server default.
        </p>
        {config?.agentImageContract.outdated && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <span className="font-semibold">This image looks out of date.</span>{" "}
            The last agent run on it{" "}
            {config.agentImageContract.lastReported === 0
              ? "was built before harness version reporting existed"
              : `reported harness version v${config.agentImageContract.lastReported}`}
            , but this server expects v{config.agentImageContract.current}.
            Stale harnesses can mis-handle newer run features (resumed runs,
            follow-up comments) and fail after the agent finishes. Rebuild the
            image from the latest agent-harness source, or clear this field to
            use the server default.
          </div>
        )}
      </div>

      {/* Repository system prompt */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-white/60">
          Repository system prompt{" "}
          <span className="font-normal text-white/30">(optional)</span>
        </label>
        <textarea
          key={
            config
              ? `sysprompt-${String(config.updatedAt)}`
              : "sysprompt-loading"
          }
          ref={systemPromptRef}
          rows={5}
          defaultValue={config?.systemPrompt ?? ""}
          placeholder={
            "e.g. Always write tests for new behaviour. Prefer small, focused commits. Follow the existing code style."
          }
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
        />
        <p className="text-xs text-white/30">
          A blanket instruction appended to the system prompt of every agent run
          for this repo — dashboard tasks, issues, and webhook-triggered runs
          alike. Layered on top of Bandolier&apos;s own framing, never replacing
          it. Leave blank for none.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
        {save.error && (
          <p className="text-xs text-red-400">{save.error.message}</p>
        )}
        {result && !save.error && (
          <p className="text-xs text-green-300">{result}</p>
        )}
      </div>
    </form>
  );
}
