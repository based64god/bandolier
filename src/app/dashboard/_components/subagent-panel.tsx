"use client";

import { useMemo, useState } from "react";

import {
  collectSubagentNarration,
  isSubagentDone,
  type SubagentNarration,
  type TimelineItem,
} from "~/lib/acp/timeline";
import { Modal } from "./modal";

// A card pinned above the conversation summarising the subagents ultracode fans
// out. Users don't drive subagents, so their narration is reference, not
// dialogue: it stays out of the main flow and the full text opens in a popout
// modal (the same treatment as the log modal) on click. As a live indicator it
// counts only running subagents and prunes itself once they've all finished —
// their results live on in the conversation's tool tree. Renders nothing until a
// subagent actually narrates, so ordinary sessions are unaffected.
export function SubagentPanel({ items }: { items: TimelineItem[] }) {
  // Recompute only when the timeline changes, not on every parent poll re-render
  // (the interactive row re-renders on each 1.5s frame pull and on scroll/focus
  // bumps); collecting narration is O(n) over the whole timeline.
  const narration = useMemo(() => collectSubagentNarration(items), [items]);
  const [open, setOpen] = useState(false);

  const running = narration.filter((n) => !isSubagentDone(n.status));
  const failed = narration.filter((n) => n.status === "failed");
  const okCount = narration.length - running.length - failed.length;

  // A live indicator: prune the card once every subagent has finished — but keep
  // it up for a failure, which is a signal worth surfacing even after the
  // subagent terminated. Successful results live on in the conversation's tool
  // tree either way. Hooks stay above this early return so render order is stable.
  if (running.length === 0 && failed.length === 0) return null;

  const active = running.length > 0;
  // Preview the newest live narration; with nothing running, show the failure's.
  const source = active
    ? running[running.length - 1]
    : failed[failed.length - 1];
  const preview = source?.entries[source.entries.length - 1]?.text ?? "";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={
          active
            ? "flex w-full items-center gap-2 border-b border-purple-400/20 bg-purple-500/[0.07] px-4 py-2 text-left text-xs hover:bg-purple-500/[0.12]"
            : "flex w-full items-center gap-2 border-b border-red-400/20 bg-red-500/[0.07] px-4 py-2 text-left text-xs hover:bg-red-500/[0.12]"
        }
        title="View subagent narration"
      >
        <span
          className={
            active
              ? "shrink-0 text-purple-300 select-none"
              : "shrink-0 text-red-300 select-none"
          }
        >
          ⇉
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium">
          {active ? (
            <span className="text-purple-200">
              {running.length} subagent{running.length === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="text-red-300">
              {failed.length} subagent{failed.length === 1 ? "" : "s"} failed
            </span>
          )}
          {active && failed.length > 0 && (
            <span className="text-red-300">· {failed.length} failed</span>
          )}
          {okCount > 0 && (
            <span className="font-normal text-white/30">· {okCount} done</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-white/40">{preview}</span>
        <span className="shrink-0 text-white/30">View →</span>
      </button>
      {open && (
        <SubagentModal narration={narration} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function SubagentModal({
  narration,
  onClose,
}: {
  narration: SubagentNarration[];
  onClose: () => void;
}) {
  const runningCount = narration.filter(
    (n) => !isSubagentDone(n.status),
  ).length;
  const failedCount = narration.filter((n) => n.status === "failed").length;
  const okCount = narration.length - runningCount - failedCount;

  return (
    <Modal
      onClose={onClose}
      title="Subagents"
      titleAccessory={
        <span className="font-mono text-[11px] text-white/40">
          {runningCount} running
          {failedCount > 0 && (
            <span className="text-red-300"> · {failedCount} failed</span>
          )}
          {okCount > 0 && ` · ${okCount} done`}
        </span>
      }
      panelClassName="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
    >
      <div className="space-y-2 overflow-auto p-4">
        {narration.map((s) => (
          <SubagentNarrationBlock key={s.toolCallId} subagent={s} />
        ))}
      </div>
    </Modal>
  );
}

// One subagent's narration, collapsed by default so a long log doesn't flood the
// modal — the header alone identifies the subagent and its status; expand to read
// the transcript.
function SubagentNarrationBlock({ subagent }: { subagent: SubagentNarration }) {
  return (
    <details className="group/sub overflow-hidden rounded-md border border-white/10 bg-white/[0.02]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="h-2.5 w-2.5 shrink-0 text-white/40 transition-transform group-open/sub:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span className="shrink-0 text-purple-300 select-none">⇉</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-purple-200">
          {subagent.label}
        </span>
        <SubagentStatusBadge status={subagent.status} />
      </summary>
      <div className="space-y-1 border-t border-white/10 py-2 pr-3 pl-6">
        {subagent.entries.map((e, i) => (
          <p
            key={i}
            className={
              e.variant === "thinking"
                ? "font-mono text-[11px] break-words whitespace-pre-wrap text-white/35 italic"
                : "text-sm break-words whitespace-pre-wrap text-white/80"
            }
          >
            {e.text}
          </p>
        ))}
      </div>
    </details>
  );
}

function SubagentStatusBadge({ status }: { status: string }) {
  if (status === "failed") {
    return (
      <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
        failed
      </span>
    );
  }
  if (isSubagentDone(status)) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
        done
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] text-purple-200">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" />
      running
    </span>
  );
}
