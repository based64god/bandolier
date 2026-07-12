"use client";

import { useState } from "react";

import {
  collectSubagentNarration,
  type SubagentNarration,
  type TimelineItem,
} from "~/lib/acp/timeline";
import { Modal } from "./modal";

// A card pinned above the conversation summarising the subagents ultracode fans
// out. Users don't drive subagents, so their narration is reference, not
// dialogue: it stays out of the main flow and the full text opens in a popout
// modal (the same treatment as the log modal) on click. Renders nothing until a
// subagent actually narrates, so ordinary sessions are unaffected.
export function SubagentPanel({ items }: { items: TimelineItem[] }) {
  const narration = collectSubagentNarration(items);
  const [open, setOpen] = useState(false);
  if (narration.length === 0) return null;

  const latest = narration[narration.length - 1];
  const preview = latest?.entries[latest.entries.length - 1]?.text ?? "";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 border-b border-purple-400/20 bg-purple-500/[0.07] px-4 py-2 text-left text-xs hover:bg-purple-500/[0.12]"
        title="View subagent narration"
      >
        <span className="shrink-0 text-purple-300 select-none">⇉</span>
        <span className="shrink-0 font-medium text-purple-200">
          {narration.length} subagent{narration.length === 1 ? "" : "s"}
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
  return (
    <Modal
      onClose={onClose}
      title="Subagents"
      titleAccessory={
        <span className="font-mono text-[11px] text-white/40">
          {narration.length} running
        </span>
      }
      panelClassName="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
    >
      <div className="space-y-4 overflow-auto p-4">
        {narration.map((s) => (
          <div key={s.toolCallId}>
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-purple-300">
              <span className="select-none">⇉</span>
              <span className="break-words">{s.label}</span>
            </div>
            <div className="space-y-1 border-l border-white/10 pl-3">
              {s.entries.map((e, i) => (
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
          </div>
        ))}
      </div>
    </Modal>
  );
}
