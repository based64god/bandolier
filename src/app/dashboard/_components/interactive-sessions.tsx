"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import { STATUS_STYLES } from "./agent-ui";

export interface InteractiveAgent {
  name: string;
  jobName: string;
  displayName: string;
  status: string;
  awaitingInput: boolean;
  pullRequestUrl: string | null;
}

/**
 * Renders interactive agents as live cards pinned to the top of the dashboard:
 * streamed logs, an input box, and a prominent "waiting for input" state.
 */
export function InteractiveSessions({
  agents,
  namespace,
}: {
  agents: InteractiveAgent[];
  namespace: string;
}) {
  if (agents.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider text-white/40 uppercase">
        Interactive sessions
        <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/50">
          {agents.length}
        </span>
      </h2>
      <div className="space-y-3">
        {agents.map((agent) => (
          <InteractiveCard
            key={agent.name}
            agent={agent}
            namespace={namespace}
          />
        ))}
      </div>
    </section>
  );
}

function InteractiveCard({
  agent,
  namespace,
}: {
  agent: InteractiveAgent;
  namespace: string;
}) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const running = agent.status === "Running" || agent.status === "Pending";
  const utils = api.useUtils();

  const awaiting = agent.awaitingInput;

  // An agent that starts waiting for input pops back open even if the user had
  // collapsed it — that's the moment they need to see it. We expand only on the
  // false→true transition so the user can re-collapse while it keeps waiting.
  const wasAwaiting = useRef(awaiting);
  useEffect(() => {
    if (awaiting && !wasAwaiting.current) setCollapsed(false);
    wasAwaiting.current = awaiting;
  }, [awaiting]);

  const { data: logs } = api.agents.getLogs.useQuery(
    {
      podName: agent.name,
      namespace,
      jobName: agent.jobName,
      tailLines: 400,
    },
    { refetchInterval: running ? 2500 : false },
  );

  const sendInput = api.agents.sendInput.useMutation({
    onSuccess: () => {
      setDraft("");
      // Nudge the log poll so the agent's RESUME shows up promptly.
      void utils.agents.getLogs.invalidate({ podName: agent.name, namespace });
    },
  });
  const endSession = api.agents.endSession.useMutation();
  const terminate = api.agents.terminate.useMutation();

  function send() {
    const content = draft.trim();
    if (!content || sendInput.isPending) return;
    sendInput.mutate({ namespace, jobName: agent.jobName, content });
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border ${
        awaiting
          ? "border-amber-400/60 bg-amber-500/[0.06] shadow-[0_0_0_1px_rgba(251,191,36,0.25)]"
          : "border-white/10 bg-white/5"
      }`}
    >
      {/* Header — click anywhere (outside the action buttons) to collapse. */}
      <div
        onClick={() => setCollapsed((c) => !c)}
        className="flex cursor-pointer items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5 select-none"
      >
        <div className="flex min-w-0 items-center gap-2">
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-white/40 transition-transform ${
              collapsed ? "-rotate-90" : ""
            }`}
          >
            <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
          <span className="truncate text-sm text-white/90">
            {agent.displayName}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[agent.status] ?? STATUS_STYLES.Unknown}`}
          >
            {agent.status}
          </span>
          {awaiting && (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
              Waiting for input
            </span>
          )}
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex shrink-0 items-center gap-2"
        >
          {agent.pullRequestUrl && (
            <a
              href={agent.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-xs text-purple-300 hover:bg-purple-500/20"
            >
              Pull request
            </a>
          )}
          {running && (
            <button
              onClick={() =>
                endSession.mutate({ namespace, jobName: agent.jobName })
              }
              disabled={endSession.isPending || endSession.isSuccess}
              className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/60 hover:bg-white/10 disabled:opacity-40"
              title="Close the session and open a PR if there are commits"
            >
              {endSession.isSuccess ? "Ending…" : "End session"}
            </button>
          )}
          <button
            onClick={() => terminate.mutate({ podName: agent.name, namespace })}
            disabled={terminate.isPending}
            aria-label="Terminate agent"
            className="rounded p-1 text-red-500/50 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Logs */}
          <LogView text={logs ?? ""} />

          {/* Input */}
          <div className="border-t border-white/10 p-3">
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={!running}
                placeholder={
                  running
                    ? awaiting
                      ? "The agent is waiting — type a message and press Enter…"
                      : "Send a message (the agent will pick it up after its current turn)…"
                    : "Session ended."
                }
                className="min-h-0 flex-1 resize-y rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none disabled:opacity-40"
              />
              <button
                onClick={send}
                disabled={!running || !draft.trim() || sendInput.isPending}
                className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sendInput.isPending ? "Sending…" : "Send"}
              </button>
            </div>
            {sendInput.error && (
              <p className="mt-1.5 text-xs text-red-400">
                {sendInput.error.message}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Scrollable log pane that dims harness lines and auto-sticks to the bottom. */
function LogView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = text ? text.split("\n") : [];

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="h-72 overflow-auto bg-black/30 px-4 py-3 font-mono text-[11px] leading-5"
    >
      {lines.length === 0 ? (
        <span className="text-white/30">Waiting for output…</span>
      ) : (
        lines.map((line, i) => (
          <div
            key={i}
            className={`break-words whitespace-pre-wrap ${
              line.includes("[harness]") ? "text-white/35" : "text-white/80"
            }`}
          >
            {line || " "}
          </div>
        ))
      )}
    </div>
  );
}
