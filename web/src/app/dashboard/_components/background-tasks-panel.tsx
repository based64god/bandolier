"use client";

import { useMemo, useState } from "react";

import {
  collectBackgroundTasks,
  type BackgroundTask,
  type TimelineItem,
} from "~/lib/acp/timeline";
import { Modal } from "./modal";

// A card pinned above the conversation while background subagent tasks are in
// flight. A backgrounded task's own spawn tool call completes the instant it hands
// back a handle, so the conversation's tool tree can't convey that the task is
// still running; the harness reports the live set separately (a
// _bandolier/background_tasks frame) and this surfaces it. As a live indicator it
// prunes itself once the set drains — each task's results live on in the
// conversation's tool tree — and renders nothing when idle, so ordinary sessions
// are unaffected. Sits beside SubagentPanel: that card covers synchronous
// subagents the agent is blocked on, this one the tasks it has backgrounded.
export function BackgroundTasksPanel({
  taskIds,
  items,
  running,
}: {
  taskIds: string[];
  items: TimelineItem[];
  // Whether the session is still live. A background task only runs while the
  // session does, and an abnormally-ended session (pod killed / expired / OOM)
  // never emits a drain frame — so its last non-empty set would otherwise linger in
  // the durable log and show phantom "running" work on every replay. Gate on this.
  running: boolean;
}) {
  // Recompute only when the set or timeline actually changes — not on the
  // scroll/focus re-renders the interactive row also does, where taskIds/items keep
  // their identity; correlating ids to spawn labels is O(n) over the timeline.
  const tasks = useMemo(
    () => collectBackgroundTasks(taskIds, items),
    [taskIds, items],
  );
  const [open, setOpen] = useState(false);

  // A live indicator: nothing to show once the set has drained, or once the session
  // is no longer running (a terminal session has no live background work and may
  // never have emitted a drain). Hooks stay above this early return so render order
  // is stable.
  if (!running || tasks.length === 0) return null;

  // Preview the newest task's label when one is known, else stay generic.
  const preview = taskLabel(tasks[tasks.length - 1]!, tasks.length - 1);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 border-b border-amber-400/20 bg-amber-500/[0.07] px-4 py-2 text-left text-xs hover:bg-amber-500/[0.12]"
        title="View background tasks"
      >
        <span className="shrink-0 animate-pulse text-amber-300 select-none">
          ⧗
        </span>
        <span className="shrink-0 font-medium text-amber-200">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} running in the
          background
        </span>
        <span className="min-w-0 flex-1 truncate text-white/40">{preview}</span>
        <span className="shrink-0 text-white/30">View →</span>
      </button>
      {open && (
        <BackgroundTasksModal tasks={tasks} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// A stable, human-readable name for a background task: its subagent spawn's label
// when known (background task ids and spawn ids don't always coincide, and a spawn
// may be outside the fetched window), else a positional fallback so an
// uncorrelated task still reads as a task.
function taskLabel(task: BackgroundTask, index: number): string {
  // collectBackgroundTasks omits empty labels, so `??` reliably falls back here.
  return task.label ?? `Background task ${index + 1}`;
}

function BackgroundTasksModal({
  tasks,
  onClose,
}: {
  tasks: BackgroundTask[];
  onClose: () => void;
}) {
  return (
    <Modal
      onClose={onClose}
      title="Background tasks"
      titleAccessory={
        <span className="font-mono text-[11px] text-white/40">
          {tasks.length} running
        </span>
      }
      panelClassName="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
    >
      <div className="space-y-1 overflow-auto p-4">
        {tasks.map((task, i) => (
          <div
            key={task.id}
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
            <span className="min-w-0 flex-1 truncate text-sm text-white/80">
              {taskLabel(task, i)}
            </span>
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
              running
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
