"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresAtLocal } from "./agent-ui";
import { HarnessSegment, UserSegment } from "./log-modal";
import { parseSegments } from "./log-segments";
import { OutputBadge, SourceBadge } from "./output-badge";
import { StatusBadge } from "./status-badge";
import {
  ACTION_ROW_MIN_H,
  MOBILE_TASK_COLUMNS,
  TASK_COLUMNS,
} from "./task-row";

type Task = RouterOutputs["agents"]["list"][number];

// Mirrors Tailwind's `lg` breakpoint (64rem / 1024px), which is where the table
// shows or hides its three secondary columns.
const LG_QUERY = "(min-width: 64rem)";

/**
 * Tracks whether the viewport is at or above the `lg` breakpoint, so the
 * expanded row can span exactly the columns that are actually rendered. Starts
 * `true` to match SSR (where the optional columns are present) and corrects on
 * mount, avoiding a hydration mismatch.
 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(LG_QUERY);
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

/**
 * Renders an interactive agent as a row in the task table: the same columns as a
 * non-interactive task when collapsed, expanding in place to reveal streamed
 * logs and an input box. Auto-expands when it starts awaiting input and
 * auto-collapses when the session finishes.
 */
export function InteractiveRow({
  agent,
  namespace,
  repoFullName,
}: {
  agent: Task;
  namespace: string;
  repoFullName?: string;
}) {
  const [draft, setDraft] = useState("");
  const running = agent.status === "Running" || agent.status === "Pending";
  // Default closed for sessions that are already done when first mounted —
  // there's nothing to interact with, so keep them out of the way. Live
  // sessions start open. The effects below handle later status transitions.
  const [collapsed, setCollapsed] = useState(!running);
  const isDesktop = useIsDesktop();
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

  // When a session finishes (running→done) there's nothing left to interact
  // with, so we collapse it to get it out of the way. Mirror of the expand
  // logic above: only on the true→false transition, so the user can re-open a
  // completed session to read its final output.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (!running && wasRunning.current) setCollapsed(true);
    wasRunning.current = running;
  }, [running]);

  const { data: logs } = api.agents.getLogs.useQuery(
    {
      podName: agent.name,
      namespace,
      jobName: agent.jobName,
      repoFullName,
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
    sendInput.mutate({
      namespace,
      jobName: agent.jobName,
      content,
      repoFullName,
    });
  }

  const rowTint = awaiting ? "bg-amber-500/[0.06]" : "hover:bg-white/[0.04]";

  return (
    <>
      {/* Collapsed header row — same columns as a non-interactive task. Click
          anywhere (outside links/buttons) to expand the live session. */}
      <tr
        onClick={() => setCollapsed((c) => !c)}
        className={`cursor-pointer select-none ${rowTint}`}
      >
        {/* Status (+ awaiting pill) — centered to match the centered "Status"
            header and the non-interactive TaskRow. The pills stack vertically
            (mirroring the overview panel) so the status badge itself stays
            centered under the header: a horizontal row would center the
            badge+"Waiting" pair as a group, leaving the status badge offset to
            the left of the column. */}
        <td className="px-3 py-2 text-center align-middle md:px-4 md:py-3">
          <div className="flex flex-col items-center gap-1">
            <StatusBadge status={agent.status} />
            {awaiting && (
              <span
                title="Waiting"
                aria-label="Waiting"
                className="flex items-center justify-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-200 md:px-2"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                <span className="hidden md:inline">Waiting</span>
              </span>
            )}
          </div>
        </td>

        {/* Output */}
        <td
          className="px-4 py-2 text-center align-middle md:px-5 md:py-3"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Centered to match the centered "Output" header — a flex wrapper
              keeps the badge (or the empty-state dash) centered regardless of
              its width, mirroring the Status cell. */}
          <div className="flex justify-center">
            <OutputBadge
              createdIssueUrl={agent.createdIssueUrl}
              createdIssueState={agent.createdIssueState}
              pullRequestUrl={agent.pullRequestUrl}
              pullRequestState={agent.pullRequestState}
            />
          </div>
        </td>

        {/* Task (chevron + name) */}
        <td className="px-3 py-2 align-middle md:px-4 md:py-3">
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
            {/* Always clamped to one line so a long description can't wrap and
                grow the row taller than its single-line neighbours; the full
                text is available on hover. `min-w-0` lets this flex child
                shrink below its content width — without it the item's default
                `min-width: auto` keeps it at full text width and `truncate`
                never engages. */}
            <span
              title={agent.displayName}
              className="min-w-0 truncate text-sm text-white/90"
            >
              {agent.displayName}
            </span>
          </div>
        </td>

        {/* Created by — shown only in the full layout (lg+). */}
        <td
          className="hidden px-3 py-2 align-middle md:px-4 md:py-3 lg:table-cell"
          onClick={(e) => e.stopPropagation()}
        >
          <SourceBadge
            source={agent.source}
            issueUrl={agent.issueUrl}
            issueNumber={agent.issueNumber}
            issueState={agent.issueState}
            createdBy={agent.createdBy}
          />
        </td>

        {/* Currently — clamped to one line, full text on hover. Shown only in
            the full layout (lg+). */}
        <td className="hidden px-3 py-2 align-middle md:px-4 md:py-3 lg:table-cell">
          <span
            title={agent.currently ?? undefined}
            className="block max-w-[16rem] truncate text-xs text-white/40 italic"
          >
            {agent.currently ?? "—"}
          </span>
        </td>

        {/* Expires — shown only in the full layout (lg+). */}
        <td className="hidden px-3 py-2 align-middle whitespace-nowrap text-white/50 tabular-nums md:px-4 md:py-3 lg:table-cell">
          {expiresAtLocal(agent.expiresAt)}
        </td>

        {/* Actions */}
        <td
          className="px-3 py-2 text-right align-middle md:px-4 md:py-3"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Reserve the tallest control's height (`ACTION_ROW_MIN_H`) so the
              row keeps a constant height whether or not the "End session"
              button is present — without it, a row shrinks the moment a
              session ends and its button disappears, shifting rows below it. */}
          <div
            className={`flex items-center justify-end gap-2 ${ACTION_ROW_MIN_H}`}
          >
            {running && (
              <button
                onClick={() =>
                  endSession.mutate({
                    namespace,
                    jobName: agent.jobName,
                    repoFullName,
                  })
                }
                disabled={endSession.isPending || endSession.isSuccess}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 disabled:opacity-40"
                title="Close the session and open a PR if there are commits"
              >
                {endSession.isSuccess ? "Ending…" : "End session"}
              </button>
            )}
            <button
              onClick={() =>
                terminate.mutate({
                  podName: agent.name,
                  namespace,
                  repoFullName,
                })
              }
              disabled={terminate.isPending}
              aria-label="Terminate agent"
              className="rounded p-1 text-red-500/50 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded body — live logs + input, spanning the full table width. */}
      {!collapsed && (
        <tr className={awaiting ? "bg-amber-500/[0.06]" : undefined}>
          {/* Span only the columns that exist at the current breakpoint. The
              three secondary columns are dropped below `lg`, so spanning all
              seven there would conjure phantom columns and re-balance the
              table, shifting every row sideways as it expands. */}
          <td
            colSpan={isDesktop ? TASK_COLUMNS : MOBILE_TASK_COLUMNS}
            className="p-0"
          >
            {/* Pod name only — the seed prompt is logged as the first [user]
                line in the transcript below, so a separate prompt block would
                just duplicate it. */}
            <SessionHeader podName={agent.name} />
            <LogView text={logs ?? ""} />
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
                  // min-w-0 lets the textarea shrink below its intrinsic width
                  // so the auto-layout table can't be forced wider than the
                  // viewport (which overflowed and shifted columns on mobile).
                  className="min-h-0 w-0 min-w-0 flex-1 resize-y rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none disabled:opacity-40"
                />
                <button
                  onClick={send}
                  disabled={!running || !draft.trim() || sendInput.isPending}
                  className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
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
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Pod name header for an expanded interactive session. The seed prompt is no
 * longer shown here — it's logged as the first [user] line in the transcript
 * below, so a separate prompt block would just duplicate it.
 */
function SessionHeader({ podName }: { podName: string }) {
  return (
    <div className="border-b border-white/10 px-4 py-3">
      <code className="inline-block max-w-full truncate rounded bg-purple-500/20 px-2 py-0.5 align-middle text-sm text-purple-300">
        {podName}
      </code>
    </div>
  );
}

/** Scrollable log pane that dims harness lines and auto-sticks to the bottom. */
function LogView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. Mirrored into state so the
  // "scroll to bottom" button can show/hide as the user scrolls away.
  const stick = useRef(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  function scrollToBottom() {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setPinned(true);
  }

  // Group lines so runs of [harness] diagnostics collapse the same way they do
  // in the non-interactive LogModal, keeping Claude's output front and center.
  const segments = text ? parseSegments(text) : [];

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = atBottom;
          setPinned(atBottom);
        }}
        className="h-72 overflow-auto bg-black/30 px-4 py-3 font-mono text-[11px] leading-5"
      >
        {segments.length === 0 ? (
          <span className="text-white/30">Waiting for output…</span>
        ) : (
          segments.map((seg, i) =>
            seg.kind === "harness" ? (
              <HarnessSegment key={i} lines={seg.lines} />
            ) : seg.kind === "user" ? (
              <UserSegment key={i} lines={seg.lines} />
            ) : (
              seg.lines.map((line, j) => (
                <div
                  key={`${i}-${j}`}
                  className="break-words whitespace-pre-wrap text-white/80"
                >
                  {line || " "}
                </div>
              ))
            ),
          )
        )}
      </div>
      {!pinned && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute right-3 bottom-3 flex items-center gap-1 rounded-full border border-white/15 bg-black/70 px-3 py-1.5 text-xs text-white/80 shadow-lg backdrop-blur hover:bg-black/90"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M8 1.75a.75.75 0 0 1 .75.75v8.19l2.72-2.72a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 1.06-1.06l2.72 2.72V2.5A.75.75 0 0 1 8 1.75Z" />
          </svg>
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
