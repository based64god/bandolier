"use client";

import { useRef, useState } from "react";

import { env } from "~/env";
import { api } from "~/trpc/react";
import { ToggleSection } from "../credential-ui";
import { Modal } from "../modal";
import { RepoCredentialsSection } from "./credentials-sections";
import {
  RepoDefaultComputeSection,
  RepoDefaultEffortSection,
  RepoDefaultModelSection,
} from "./defaults-sections";
import { RepoNetworkPolicySection } from "./network-policy-section";
import { RepoResumeSection } from "./toggles";

export function RepoConfigModal({
  repoFullName,
  onClose,
}: {
  repoFullName: string;
  onClose: () => void;
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

  const setTriggerAll = api.webhooks.setTriggerOnAllEvents.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  // The GitHub App install page; null when no slug is configured (self-hosters
  // who haven't set NEXT_PUBLIC_GITHUB_APP_SLUG), in which case we show generic
  // guidance instead of a broken link.
  const installUrl = env.NEXT_PUBLIC_GITHUB_APP_SLUG;

  return (
    <Modal
      onClose={onClose}
      title="Repository configuration"
      titleAccessory={
        <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
          {repoFullName}
        </code>
      }
      headerClassName="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-5 py-4"
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
    >
      <div className="space-y-5 overflow-y-auto px-5 py-5">
        <p className="text-xs text-white/40">
          Repository-level settings for this repo: when agents trigger, the
          image they run on, the system prompt they get, and the shared
          credentials they use. Event delivery is handled by the Bandolier
          GitHub App — install it on this repo (below) rather than configuring a
          webhook by hand.
        </p>

        {/* GitHub App install */}
        <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
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
              <code className="text-white/50">NEXT_PUBLIC_GITHUB_APP_SLUG</code>{" "}
              to surface it here).
            </p>
          )}
        </div>

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
          {/* Trigger prefix */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-white/60">
              Trigger prefix{" "}
              <span className="font-normal text-white/30">(optional)</span>
            </label>
            <input
              key={
                config ? `prefix-${String(config.updatedAt)}` : "prefix-loading"
              }
              ref={prefixRef}
              type="text"
              defaultValue={config?.prefix ?? ""}
              placeholder="e.g. @bando"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none"
            />
            <p className="text-xs text-white/30">
              Only events whose title or body contains this text trigger an
              agent. Without a prefix (and with the toggle below off), webhook
              events never trigger agents.
            </p>
            <ToggleSection
              label="Always trigger on events"
              description="Fire an agent on every issue and comment event, ignoring the trigger prefix. Fired events spend the initiating user's (or the repo's shared) credentials."
              enabled={config?.triggerOnAllEvents ?? false}
              disabled={setTriggerAll.isPending || !config}
              onChange={(v) =>
                setTriggerAll.mutate({ repoFullName, enabled: v })
              }
              accent="purple"
              switchAriaLabel="Always trigger on webhook events"
            />
            {setTriggerAll.error && (
              <p className="text-xs text-red-400">
                {setTriggerAll.error.message}
              </p>
            )}
          </div>

          {/* Agent image */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-white/60">
              Agent image{" "}
              <span className="font-normal text-white/30">(optional)</span>
            </label>
            <input
              key={
                config ? `image-${String(config.updatedAt)}` : "image-loading"
              }
              ref={agentImageRef}
              type="text"
              defaultValue={config?.agentImage ?? ""}
              placeholder="e.g. ghcr.io/based64god/bandolier-agent-harness:latest"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder-white/30 placeholder:font-sans focus:border-purple-500/50 focus:outline-none"
            />
            <p className="text-xs text-white/30">
              Container image agents for this repo run on. Leave blank to use
              the server default.
            </p>
            {config?.agentImageContract.outdated && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <span className="font-semibold">
                  This image looks out of date.
                </span>{" "}
                The last agent run on it{" "}
                {config.agentImageContract.lastReported === 0
                  ? "was built before harness version reporting existed"
                  : `reported harness version v${config.agentImageContract.lastReported}`}
                , but this server expects v{config.agentImageContract.current}.
                Stale harnesses can mis-handle newer run features (resumed runs,
                follow-up comments) and fail after the agent finishes. Rebuild
                the image from the latest agent-harness source, or clear this
                field to use the server default.
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
              A blanket instruction appended to the system prompt of every agent
              run for this repo — dashboard tasks, issues, and webhook-triggered
              runs alike. Layered on top of Bandolier&apos;s own framing, never
              replacing it. Leave blank for none.
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

        <p className="text-[11px] text-white/30">
          Agents triggered by an event run with the credentials of the GitHub
          user who initiated it (e.g. the issue opener), so that user must be
          signed in to Bandolier with model and cluster credentials configured —
          or this repo must provide shared ones below.
        </p>

        <RepoDefaultModelSection repoFullName={repoFullName} />

        <RepoDefaultEffortSection repoFullName={repoFullName} />

        <RepoResumeSection repoFullName={repoFullName} />

        <RepoDefaultComputeSection repoFullName={repoFullName} />

        <RepoCredentialsSection repoFullName={repoFullName} />

        <RepoNetworkPolicySection repoFullName={repoFullName} />
      </div>
    </Modal>
  );
}
