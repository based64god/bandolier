"use client";

import { useEffect, useRef, useState } from "react";

import { groupTimeline, type TimelineItem } from "~/lib/acp/timeline";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresAtLocal, taskNameTooltip } from "./agent-ui";
import { OutputBadge, SourceBadge } from "./output-badge";
import { SessionComposer } from "./session-composer";
import { StatusBadge } from "./status-badge";
import { TokenReadout } from "./token-readout";
import {
  ACTION_ROW_MIN_H,
  LG_TASK_COLUMNS,
  MOBILE_TASK_COLUMNS,
  TASK_COLUMNS,
} from "./task-row";
import { useAcpSession } from "./use-acp-session";

type Task = RouterOutputs["agents"]["list"][number];

// Mirror Tailwind's `lg` (64rem / 1024px) and `xl` (80rem / 1280px)
// breakpoints: "Created by"/"Expires" join the table at `lg`, "Currently" at
// `xl`.
const LG_QUERY = "(min-width: 64rem)";
const XL_QUERY = "(min-width: 80rem)";

/**
 * The number of task-table columns rendered at the current viewport, so the
 * expanded row can span exactly the columns that actually exist. Starts at the
 * full count to match SSR (where every column is present) and corrects on
 * mount, avoiding a hydration mismatch.
 */
function useTaskColumnCount() {
  const [count, setCount] = useState(TASK_COLUMNS);
  useEffect(() => {
    const lg = window.matchMedia(LG_QUERY);
    const xl = window.matchMedia(XL_QUERY);
    const update = () =>
      setCount(
        xl.matches
          ? TASK_COLUMNS
          : lg.matches
            ? LG_TASK_COLUMNS
            : MOBILE_TASK_COLUMNS,
      );
    update();
    lg.addEventListener("change", update);
    xl.addEventListener("change", update);
    return () => {
      lg.removeEventListener("change", update);
      xl.removeEventListener("change", update);
    };
  }, []);
  return count;
}

/**
 * Renders an interactive agent as a row in the task table: the same columns as a
 * non-interactive task when collapsed, expanding in place to reveal the live ACP
 * conversation and an input box. Auto-expands when it starts awaiting input and
 * auto-collapses when the session finishes.
 *
 * The conversation is driven over the Agent Client Protocol: the frontend is the
 * ACP client (see useAcpSession), the harness proxies it to the in-pod agent.
 */
export function InteractiveRow({
  agent,
  namespace,
  repoFullName,
  focusSignal,
}: {
  agent: Task;
  namespace: string;
  repoFullName?: string;
  /**
   * Bumped by the dashboard when Tab cycles to this session: expand the row (so
   * the composer mounts) and forward the signal to the composer, which moves
   * keyboard focus into its textarea. `null`/`0` means "not the target".
   */
  focusSignal?: number | null;
}) {
  const [ending, setEnding] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const running = agent.status === "Running" || agent.status === "Pending";
  // Default closed for sessions that are already done when first mounted —
  // there's nothing to interact with, so keep them out of the way. Live
  // sessions start open. The effects below handle later status transitions.
  const [collapsed, setCollapsed] = useState(!running);
  const columnCount = useTaskColumnCount();

  // Anchor on the collapsed header row so we can bring the whole session to the
  // top of the viewport when it opens: its expanded body is ~full-height
  // (`85vh`), so aligning this row's top with the viewport top makes the session
  // fill the screen rather than sit half-scrolled with its input off-screen.
  const rowRef = useRef<HTMLTableRowElement>(null);
  const revealSession = () => {
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const awaiting = agent.awaitingInput;

  // Poll only while the conversation is open: a collapsed session's waiting
  // state still surfaces via the agents.list query, and expanding replays the
  // backlog from the cursor, so there's no reason to stream a chat no one is
  // looking at. A finished session still replays when expanded — the frames
  // are durable — the hook just stops polling once the backlog is drained.
  const session = useAcpSession({
    namespace,
    jobName: agent.jobName,
    repoFullName,
    running,
    enabled: !collapsed,
  });

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

  // Whenever the session opens (user click, auto-expand on awaiting, or Tab),
  // scroll it up so its full-height body fills the viewport. Fires only on the
  // collapsed→expanded transition — not on the initial mount of an already-open
  // running session, where `wasCollapsed` starts equal to `collapsed`.
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (!collapsed && wasCollapsed.current) revealSession();
    wasCollapsed.current = collapsed;
  }, [collapsed]);

  // Tab-to-cycle: when the dashboard targets this row it bumps focusSignal. We
  // expand so the composer mounts; the signal flows down to the composer, which
  // focuses its textarea once rendered. Guarded on the value *changing* (mirror
  // of the await/running effects above) so it only fires on a fresh request.
  // Also scroll the session into view: if it was already open the expand effect
  // above won't fire, so Tab-cycling to an on-screen session still recenters it.
  const lastFocusSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal && focusSignal !== lastFocusSignal.current) {
      setCollapsed(false);
      revealSession();
    }
    lastFocusSignal.current = focusSignal;
  }, [focusSignal]);

  const utils = api.useUtils();
  const terminate = api.agents.terminate.useMutation({
    // Refetch the list immediately so the row reflects the deletion as soon as
    // the cluster does; until then the optimistic "Terminating" cue fills the
    // gap (see TaskRow for the same pattern).
    onSuccess: () => utils.agents.list.invalidate({ namespace }),
  });
  // Optimistic cue held from the terminate click until this row unmounts (pod
  // gone). The pod lingers in the list while Kubernetes winds it down.
  const terminating = terminate.isPending || terminate.isSuccess;

  const rowTint = terminating
    ? "opacity-50"
    : awaiting
      ? "bg-amber-500/[0.06]"
      : "hover:bg-white/[0.04]";

  return (
    <>
      {/* Collapsed header row — same columns as a non-interactive task. Click
          anywhere (outside links/buttons) to expand the live session. */}
      <tr
        ref={rowRef}
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
            {terminating ? (
              <StatusBadge status="Terminating" />
            ) : (
              <StatusBadge status={agent.status} failure={agent.failure} />
            )}
            {!terminating && awaiting && (
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
              title={taskNameTooltip(agent)}
              className="min-w-0 truncate text-sm text-white/90"
            >
              {agent.displayName}
            </span>
            <TokenReadout tokens={agent.tokens} className="text-[11px]" />
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

        {/* Currently — clamped to one line, full text on hover. Shown only
            from `xl` up, where the table can afford it alongside the fixed
            columns (matches TaskRow). */}
        <td className="hidden px-3 py-2 align-middle md:px-4 md:py-3 xl:table-cell">
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
              control is present — without it, a row shrinks the moment a
              session ends and its button disappears, shifting rows below it.
              On mobile the "End session" button is a compact icon (below) so it
              and the terminate glyph fit on one line inside the Actions column,
              keeping a running row the same height as its single-line
              neighbours; the full-text button appears from `lg` up. `flex-wrap`
              is only a safety net for ultra-narrow viewports — at the widths the
              Actions column is sized for, the pair never wraps. */}
          <div
            className={`flex flex-wrap items-center justify-end gap-2 lg:flex-nowrap ${ACTION_ROW_MIN_H}`}
          >
            {terminating ? (
              // Deletion requested — controls are gone (nothing left to
              // confirm) and the status pill carries the "Terminating" cue.
              <span className="text-xs text-white/25">Terminating…</span>
            ) : confirmKill ? (
              // Two-step confirm for the destructive terminate, mirroring the
              // non-interactive TaskRow: the red × arms this state, then a
              // Confirm/Cancel pair (compact glyphs on mobile, full labels from
              // `lg` up) replaces the End-session + terminate controls so the
              // pair keeps their footprint and stays on one line.
              <>
                <button
                  onClick={() =>
                    terminate.mutate({
                      podName: agent.name,
                      namespace,
                      repoFullName,
                    })
                  }
                  disabled={terminate.isPending}
                  aria-label="Confirm"
                  className="flex items-center justify-center rounded bg-red-600/40 p-1 text-xs text-red-200 hover:bg-red-600/60 disabled:opacity-50 lg:px-2 lg:py-1"
                >
                  <span className="hidden lg:inline">
                    {terminate.isPending ? "…" : "Confirm"}
                  </span>
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                    className="h-5 w-5 lg:hidden"
                  >
                    <path d="M6.5 10.086 3.707 7.293a1 1 0 0 0-1.414 1.414l3.5 3.5a1 1 0 0 0 1.414 0l7-7a1 1 0 0 0-1.414-1.414L6.5 10.086Z" />
                  </svg>
                </button>
                <button
                  onClick={() => setConfirmKill(false)}
                  aria-label="Cancel"
                  className="flex items-center justify-center rounded bg-white/10 p-1 text-xs hover:bg-white/20 lg:px-2 lg:py-1"
                >
                  <span className="hidden lg:inline">Cancel</span>
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                    className="h-5 w-5 lg:hidden"
                  >
                    <path d="M6.53 3.47a.75.75 0 0 1 0 1.06L4.81 6.25H10a3.75 3.75 0 0 1 0 7.5H8a.75.75 0 0 1 0-1.5h2a2.25 2.25 0 0 0 0-4.5H4.81l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 0Z" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                {running && (
                  <button
                    onClick={() => {
                      setEnding(true);
                      session.endSession();
                    }}
                    disabled={ending}
                    className="flex items-center justify-center rounded-md border border-white/10 p-1 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 disabled:opacity-40 lg:px-3 lg:py-1.5"
                    title="Close the session and open a PR if there are commits"
                    aria-label="End session"
                  >
                    {/* Full label from `lg` up; a compact "stop" glyph on mobile
                        so the control keeps the terminate glyph's footprint and
                        the two stay on one line within the slim Actions column. */}
                    <span className="hidden lg:inline">
                      {ending ? "Ending…" : "End session"}
                    </span>
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      aria-hidden="true"
                      className="h-5 w-5 lg:hidden"
                    >
                      <rect x="4" y="4" width="8" height="8" rx="1.5" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => setConfirmKill(true)}
                  aria-label="Terminate agent"
                  className="rounded p-1 text-red-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-5 w-5"
                  >
                    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded body — live conversation + input, spanning the full table
          width. */}
      {!collapsed && (
        <tr className={awaiting ? "bg-amber-500/[0.06]" : undefined}>
          {/* Span only the columns that exist at the current breakpoint —
              secondary columns join at `lg` and `xl` — so the expanded body
              never conjures phantom columns that would re-balance the table
              and shift every row sideways as it expands. */}
          <td colSpan={columnCount} className="p-0">
            {/* Fill the viewport (`85vh`) so an expanded session dominates the
                screen: the header and composer take their natural height while
                the conversation flexes to fill the rest and scrolls. Because a
                single expanded session is this tall, Tab-cycling between waiting
                tasks pushes the neighbouring rows off-screen — each awaiting
                session reads as its own full view rather than a cramped inline
                pane competing with the others. `min-h-0` lets the conversation
                shrink below its content so the flex child actually scrolls. */}
            <div className="flex h-[85vh] flex-col">
              <div className="shrink-0">
                <SessionHeader podName={agent.name} tokens={agent.tokens} />
              </div>
              <Conversation items={session.items} running={running} />
              <div className="shrink-0">
                <SessionComposer
                  running={running}
                  awaiting={awaiting}
                  ready={session.ready}
                  sendPending={session.sendPending}
                  sendError={session.sendError}
                  commands={session.commands}
                  onSend={session.sendPrompt}
                  focusSignal={focusSignal}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Pod name header for an expanded interactive session. The seed prompt shows as
 * the first user message in the conversation below, so it isn't repeated here.
 */
function SessionHeader({
  podName,
  tokens,
}: {
  podName: string;
  tokens: Task["tokens"];
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
      <code className="min-w-0 truncate rounded bg-purple-500/20 px-2 py-0.5 align-middle text-sm text-purple-300">
        {podName}
      </code>
      <TokenReadout tokens={tokens} className="text-xs" />
    </div>
  );
}

/**
 * Scrollable conversation pane rendering the ACP timeline: user and assistant
 * messages plus structured tool-call rows. Auto-sticks to the bottom as new
 * items stream in.
 */
function Conversation({
  items,
  running,
}: {
  items: TimelineItem[];
  running: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. Mirrored into state so the
  // "scroll to bottom" button can show/hide as the user scrolls away.
  const stick = useRef(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  function scrollToBottom() {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setPinned(true);
  }

  return (
    // Grow to fill the expanded session's flex column; `min-h-0` overrides the
    // default `min-height: auto` so this can shrink below its content and hand a
    // bounded height to the scroll container below.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = atBottom;
          setPinned(atBottom);
        }}
        className="min-h-0 flex-1 space-y-2 overflow-auto bg-black/30 px-4 py-3 text-[13px] leading-5"
      >
        {items.length === 0 ? (
          <span className="font-mono text-[11px] text-white/30">
            {running ? "Waiting for output…" : "No transcript."}
          </span>
        ) : (
          groupTimeline(items).map((group) =>
            group.type === "tools" ? (
              <ToolGroup key={group.id} items={group.items} />
            ) : (
              <MessageRow key={group.id} item={group.item} />
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

function MessageRow({
  item,
}: {
  item: Extract<TimelineItem, { type: "message" }>;
}) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 py-1.5 break-words whitespace-pre-wrap text-purple-100">
          {item.text}
        </div>
      </div>
    );
  }
  return (
    <div className="break-words whitespace-pre-wrap text-white/85">
      {item.text}
    </div>
  );
}

// Single-glyph badge per ACP tool-call kind, so the action reads at a glance.
const TOOL_KIND_GLYPH: Record<string, string> = {
  read: "◇",
  edit: "✎",
  execute: "›_",
  search: "⌕",
  fetch: "↗",
  think: "✦",
  other: "▢",
};

// A run of consecutive tool calls, collapsed behind a summary so the mechanical
// activity between assistant turns doesn't bury the conversation — the
// interactive mirror of the log modal's HarnessSegment. A single tool call still
// renders as one summarized row rather than a redundant fold.
function ToolGroup({
  items,
}: {
  items: Extract<TimelineItem, { type: "tool" }>[];
}) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[11px] text-white/40 hover:text-white/60 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="h-2.5 w-2.5 shrink-0 transition-transform group-open:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span>
          {items.length} tool {items.length === 1 ? "call" : "calls"}
        </span>
      </summary>
      <div className="mt-1 ml-4 space-y-1 border-l border-white/10 pl-3">
        {items.map((item) => (
          <ToolRow key={item.id} item={item} />
        ))}
      </div>
    </details>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { type: "tool" }> }) {
  const glyph = TOOL_KIND_GLYPH[item.kind] ?? TOOL_KIND_GLYPH.other;
  return (
    <div className="flex items-start gap-2 font-mono text-[11px] text-white/45">
      <span className="mt-px shrink-0 text-white/30 select-none">{glyph}</span>
      <span className="shrink-0 uppercase">{item.kind}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap text-white/55">
        {item.title}
      </span>
    </div>
  );
}
