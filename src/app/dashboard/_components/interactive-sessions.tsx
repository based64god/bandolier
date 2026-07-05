"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { expiresAtLocal, taskNameLabel, taskNameTooltip } from "./agent-ui";
import { Conversation, SessionHeader } from "./conversation";
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
 * Runs `onChange` on each transition of `value` (the false→true, true→false, or
 * value-changed edges the four session effects below key off), passing the new
 * and previous value. Replaces the hand-rolled "previous-value ref + guarded
 * effect" idiom: the ref-pair bookkeeping lives here once. `onChange` may read
 * fresh values from the enclosing render — it's held in a ref so the effect can
 * depend on `value` alone without capturing a stale closure.
 */
function useTransition<T>(
  value: T,
  onChange: (current: T, previous: T) => void,
) {
  const prev = useRef(value);
  const cb = useRef(onChange);
  // Keep the latest callback without re-running the transition effect below;
  // this effect is declared first, so it commits before that one on each render.
  useEffect(() => {
    cb.current = onChange;
  });
  useEffect(() => {
    if (!Object.is(value, prev.current)) {
      const previous = prev.current;
      prev.current = value;
      cb.current(value, previous);
    }
  }, [value]);
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
  awaitingCount = 0,
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
  /**
   * How many of the viewer's sessions are currently awaiting input. Used to
   * decide whether the awaiting transition should grab the viewport: with more
   * than one waiting, auto-scrolling would fight between rows, so we hold back.
   */
  awaitingCount?: number;
}) {
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
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

  // A local signal forwarded to the composer's `focusSignal`: both the
  // Tab-cycle path (below) and the awaiting transition bump it to move keyboard
  // focus into the textarea. `scrollBump` likewise nudges the conversation to
  // snap back to the bottom so the prompt the agent is waiting on is in view.
  // A monotonic counter feeds both so we set a plain literal (never a
  // previous-state updater) from inside the effects below.
  const bumpSeq = useRef(0);
  const [focusBump, setFocusBump] = useState(0);
  const [scrollBump, setScrollBump] = useState(0);

  // An agent that starts waiting for input pops back open even if the user had
  // collapsed it — that's the moment they need to see it. We expand only on the
  // false→true transition so the user can re-collapse while it keeps waiting.
  // On that same transition we actively surface the prompt: scroll the row into
  // view (even when it was already expanded and off-screen), snap the
  // conversation to the bottom, and focus the composer — the awaiting moment is
  // the one time the agent is blocked on the user. To avoid fighting over the
  // viewport we hold the scroll/focus back when more than one session is
  // awaiting at once, and when the user is mid-type in a composer.
  useTransition(awaiting, (isAwaiting) => {
    if (!isAwaiting) return;
    setCollapsed(false);
    const composerFocused =
      document.activeElement instanceof HTMLTextAreaElement;
    if (awaitingCount <= 1 && !composerFocused) {
      revealSession();
      const next = (bumpSeq.current += 1);
      setScrollBump(next);
      setFocusBump(next);
    }
  });

  // When a session finishes (running→done) there's nothing left to interact
  // with, so we collapse it to get it out of the way. Mirror of the expand
  // logic above: only on the true→false transition, so the user can re-open a
  // completed session to read its final output.
  useTransition(running, (isRunning) => {
    if (!isRunning) setCollapsed(true);
  });

  // Whenever the session opens (user click, auto-expand on awaiting, or Tab),
  // scroll it up so its full-height body fills the viewport. Fires only on the
  // collapsed→expanded transition — not on the initial mount of an already-open
  // running session, where the tracked value starts equal to `collapsed`.
  useTransition(collapsed, (isCollapsed) => {
    if (!isCollapsed) revealSession();
  });

  // Tab-to-cycle: when the dashboard targets this row it bumps focusSignal. We
  // expand so the composer mounts; the signal flows down to the composer, which
  // focuses its textarea once rendered. Guarded on the value *changing* (mirror
  // of the await/running effects above) so it only fires on a fresh request.
  // Also scroll the session into view: if it was already open the expand effect
  // above won't fire, so Tab-cycling to an on-screen session still recenters it.
  useTransition(focusSignal, (signal) => {
    if (!signal) return;
    setCollapsed(false);
    revealSession();
    setFocusBump((bumpSeq.current += 1));
  });

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

  // Optimistic cue held from the confirmed end-session click until the pod
  // actually stops running: the frame is in flight and the agent is committing
  // and opening its PR while still Running, so front a "Finalizing" state until
  // the real terminal status (Succeeded/Failed) lands. Bounded by `running` so
  // the cue clears the moment the session resolves rather than lingering.
  const finalizing = ending && running;

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
            ) : finalizing ? (
              <StatusBadge status="Finalizing" />
            ) : (
              <StatusBadge status={agent.status} failure={agent.failure} />
            )}
            {!terminating && !finalizing && awaiting && (
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
              className="min-w-0 flex-1 truncate text-sm text-white/90"
            >
              {taskNameLabel(agent)}
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
            ) : finalizing ? (
              // End-session confirmed — the frame is in flight and the agent is
              // wrapping up (commit + PR). Controls are gone; the status pill
              // carries the "Finalizing" cue.
              <span className="text-xs text-white/25">Finalizing…</span>
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
            ) : confirmEnd ? (
              // Two-step confirm for ending the session, mirroring the terminate
              // flow's footprint (compact glyphs on mobile, full labels from
              // `lg` up). Ending isn't destructive — it commits and opens a PR —
              // so the confirm reads neutral rather than red. Confirming arms the
              // optimistic "Finalizing" cue and dispatches the end-session frame.
              <>
                <button
                  onClick={() => {
                    setConfirmEnd(false);
                    setEnding(true);
                    session.endSession();
                  }}
                  aria-label="Confirm end session"
                  className="flex items-center justify-center rounded border border-white/10 bg-white/10 p-1 text-xs whitespace-nowrap hover:bg-white/20 lg:px-2 lg:py-1"
                >
                  <span className="hidden lg:inline">Confirm</span>
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
                  onClick={() => setConfirmEnd(false)}
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
                    onClick={() => setConfirmEnd(true)}
                    className="flex items-center justify-center rounded-md border border-white/10 p-1 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 disabled:opacity-40 lg:px-3 lg:py-1.5"
                    title="Close the session and open a PR if there are commits"
                    aria-label="End session"
                  >
                    {/* Full label from `lg` up; a compact "stop" glyph on mobile
                        so the control keeps the terminate glyph's footprint and
                        the two stay on one line within the slim Actions column. */}
                    <span className="hidden lg:inline">End session</span>
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
              <Conversation
                items={session.items}
                running={running}
                scrollSignal={scrollBump}
              />
              <div className="shrink-0">
                <SessionComposer
                  running={running}
                  awaiting={awaiting}
                  ready={session.ready}
                  sendPending={session.sendPending}
                  sendError={session.sendError}
                  commands={session.commands}
                  onSend={session.sendPrompt}
                  focusSignal={focusBump}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
