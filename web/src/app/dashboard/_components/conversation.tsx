"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  groupTimeline,
  type TimelineItem,
  type ToolNode,
} from "~/lib/acp/timeline";
import type { RouterOutputs } from "~/trpc/react";
import { TokenReadout } from "./token-readout";

type Task = RouterOutputs["agents"]["list"][number];

/**
 * Pod name header for an expanded interactive session. The seed prompt shows as
 * the first user message in the conversation below, so it isn't repeated here.
 */
export function SessionHeader({
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
export function Conversation({
  items,
  running,
  scrollSignal,
}: {
  items: TimelineItem[];
  running: boolean;
  /**
   * Bumped by the parent when the session starts awaiting input: snap to the
   * bottom and re-pin (equivalent to pressing "Scroll to bottom") so the prompt
   * the agent is waiting on is visible even if the user had scrolled up. `0` is
   * inert; only a fresh value fires, so the user can scroll away again after.
   */
  scrollSignal?: number;
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

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setPinned(true);
  }, []);

  // Re-pin to the bottom whenever the parent signals an awaiting transition.
  // Skips the mount default (0) so an already-scrolled-up user isn't yanked
  // down on first render.
  useEffect(() => {
    if (scrollSignal) scrollToBottom();
  }, [scrollSignal, scrollToBottom]);

  // Derive the render groups once per timeline change, not on every scroll
  // event (onScroll flips `pinned`, re-rendering often): grouping + tool-tree
  // building is O(n) over the whole accumulated timeline, which grows large in
  // subagent/background sessions.
  const groups = useMemo(() => groupTimeline(items), [items]);

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
          groups.map((group) =>
            group.type === "tools" ? (
              <ToolGroup key={group.id} nodes={group.nodes} />
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
  // A spawned subagent (Claude's Agent/Task tool): a fan-out mark, since its own
  // tool calls nest beneath it.
  subagent: "⇉",
  other: "▢",
};

// Total tool calls in a node forest, counting nested subagent calls, so the
// group summary reflects everything inside — not just the top-level rows.
function countNodes(nodes: ToolNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

// A run of consecutive tool calls, collapsed behind a summary so the mechanical
// activity between assistant turns doesn't bury the conversation — the
// interactive mirror of the log modal's HarnessSegment. Subagent calls nest
// under their spawn. A single tool call still renders as one summarized row.
function ToolGroup({ nodes }: { nodes: ToolNode[] }) {
  const count = countNodes(nodes);
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
          {count} tool {count === 1 ? "call" : "calls"}
        </span>
      </summary>
      <div className="mt-1 ml-4 space-y-1 border-l border-white/10 pl-3">
        {nodes.map((node) => (
          <ToolNodeRow key={node.item.id} node={node} />
        ))}
      </div>
    </details>
  );
}

// One tool call plus, indented beneath it, the calls a subagent made inside it.
// Recurses so nested subagents (an agent spawning an agent) keep nesting.
function ToolNodeRow({ node }: { node: ToolNode }) {
  if (node.children.length === 0) {
    return <ToolRow item={node.item} />;
  }
  return (
    <div>
      <ToolRow item={node.item} />
      <div className="mt-1 ml-3 space-y-1 border-l border-white/10 pl-3">
        {node.children.map((child) => (
          <ToolNodeRow key={child.item.id} node={child} />
        ))}
      </div>
    </div>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { type: "tool" }> }) {
  const glyph = TOOL_KIND_GLYPH[item.kind] ?? TOOL_KIND_GLYPH.other;
  const header = (
    <>
      <span className="mt-px shrink-0 text-white/30 select-none">{glyph}</span>
      <span className="shrink-0 uppercase">{item.kind}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap text-white/55">
        {item.title}
      </span>
    </>
  );

  // A call with no captured output stays a plain, non-interactive row.
  if (!item.output) {
    return (
      <div className="flex items-start gap-2 font-mono text-[11px] text-white/45">
        {header}
      </div>
    );
  }

  // With output, the row becomes its own expander so the result stays folded
  // away by default — expanding the enclosing tool group reveals the calls, not
  // a wall of their outputs. A chevron marks that this row can open further.
  return (
    <details className="group/tool">
      <summary className="flex cursor-pointer list-none items-start gap-2 font-mono text-[11px] text-white/45 hover:text-white/70 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="mt-0.5 h-2.5 w-2.5 shrink-0 text-white/30 transition-transform group-open/tool:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        {header}
      </summary>
      <pre className="mt-1 ml-6 max-h-64 overflow-auto rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] leading-4 break-words whitespace-pre-wrap text-white/50">
        {item.output}
      </pre>
    </details>
  );
}
