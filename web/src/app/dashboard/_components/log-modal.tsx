"use client";

import { useLayoutEffect, useRef, useState } from "react";

import type { TokenUsage } from "~/lib/tokens";
import { api } from "~/trpc/react";
import { Modal } from "./modal";
import {
  groupHarnessBlocks,
  isToolCallLine,
  parseSegments,
  SUBAGENT_MARKER,
} from "./log-segments";
import { TokenReadout } from "./token-readout";

// Lines fetched initially (enough to fill the modal) and per scroll-up page.
const INITIAL_LINES = 100;
const PAGE_LINES = 200;
const MAX_LINES = 10000;

// Renders a user's interactive message as a labeled chat turn, set apart from
// Claude's responses and harness diagnostics so it's clear what was typed in.
export function UserSegment({ lines }: { lines: string[] }) {
  return (
    <div className="my-1.5 rounded-md border border-purple-400/30 bg-purple-500/10 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-purple-300/80">
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3 w-3 shrink-0"
        >
          <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.5c-2.67 0-5 1.34-5 3v.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V13c0-1.66-2.33-3-5-3Z" />
        </svg>
        <span className="text-[10px] font-semibold tracking-wider uppercase">
          You
        </span>
      </div>
      {lines.map((line, i) => (
        <div
          key={i}
          className="font-mono text-xs leading-5 break-words whitespace-pre-wrap text-purple-50"
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}

export function HarnessSegment({ lines }: { lines: string[] }) {
  const blocks = groupHarnessBlocks(lines);
  // Count real tool calls: a → line, plus a subagent's own → calls (folded in
  // its block), mirroring the interactive countNodes. Plain diagnostics — the
  // system prompt, setup, thinking, lifecycle notes, a multi-line call's argument
  // continuations — and a call's ← output are not tool calls, so they no longer
  // inflate the count, nor zero it out for a subagent-only run.
  const toolCalls = blocks.reduce((n, b) => {
    if (b.kind === "line") return isToolCallLine(b.text) ? n + 1 : n;
    if (b.kind === "subagent") return n + b.lines.filter(isToolCallLine).length;
    return n;
  }, 0);

  // A run of nothing but plain diagnostics — no tool calls, output, or subagents
  // — is preamble the log needs to show: the setup, system prompt, and task, or
  // an assistant's between-call narration. Render it inline (dimmed) instead of
  // burying it behind a collapsed summary that reads as empty.
  if (
    blocks.length > 0 &&
    blocks.every((b) => b.kind === "line" && !isToolCallLine(b.text))
  ) {
    return (
      <div className="my-1">
        {blocks.map((b, i) =>
          b.kind === "line" ? (
            <div
              key={i}
              className="font-mono text-xs leading-5 break-all text-white/25"
            >
              {b.text}
            </div>
          ) : null,
        )}
      </div>
    );
  }

  // With folded subagent/output activity but no countable calls (e.g. a
  // background subagent whose → Agent spawn was logged in an earlier segment),
  // summarize as output rather than lying with "0 tool calls".
  const summary =
    toolCalls > 0
      ? `${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}`
      : "output";

  return (
    <details className="group my-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-white/30 hover:text-white/50 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="h-2.5 w-2.5 shrink-0 transition-transform group-open:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span className="font-mono text-xs">{summary}</span>
      </summary>
      <div className="mt-0.5 ml-4 border-l border-white/10 pl-3">
        {blocks.map((block, i) =>
          block.kind === "output" ? (
            <ToolOutput key={i} lines={block.lines} />
          ) : block.kind === "subagent" ? (
            <SubagentBlock key={i} label={block.label} lines={block.lines} />
          ) : (
            <div
              key={i}
              className="font-mono text-xs leading-5 break-all text-white/25"
            >
              {block.text}
            </div>
          ),
        )}
      </div>
    </details>
  );
}

// One subagent's activity (its Agent/Task spawn's nested tool calls, output,
// and narration), folded behind its own expander within the harness segment and
// labelled with which subagent produced it — the non-interactive echo of the
// conversation view's nested subagent tool group.
function SubagentBlock({ label, lines }: { label: string; lines: string[] }) {
  return (
    <details className="group/sub my-0.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-white/35 hover:text-white/55 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="h-2.5 w-2.5 shrink-0 transition-transform group-open/sub:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span className="font-mono text-[11px]">
          <span className="mr-1 select-none">{SUBAGENT_MARKER}</span>
          {label}
          <span className="ml-1.5 text-white/25">
            ({lines.length} {lines.length === 1 ? "line" : "lines"})
          </span>
        </span>
      </summary>
      <pre className="mt-0.5 max-h-64 overflow-auto border-l border-white/10 pl-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-white/35">
        {lines.join("\n")}
      </pre>
    </details>
  );
}

// A tool call's captured stdout/stderr, folded behind its own expander within
// the harness segment so a long result doesn't bury the surrounding calls — the
// log modal's echo of the interactive transcript's per-call output fold.
function ToolOutput({ lines }: { lines: string[] }) {
  return (
    <details className="group/out my-0.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-white/25 hover:text-white/45 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          fill="currentColor"
          className="h-2.5 w-2.5 shrink-0 transition-transform group-open/out:rotate-90"
        >
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span className="font-mono text-[11px] tracking-wide uppercase">
          output
        </span>
      </summary>
      <pre className="mt-0.5 max-h-64 overflow-auto border-l border-white/10 pl-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-white/30">
        {lines.join("\n")}
      </pre>
    </details>
  );
}

function ClaudeSegment({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) =>
        line === "" ? (
          <div key={i} className="h-2" />
        ) : (
          <div
            key={i}
            className="-mx-4 bg-white/[0.04] px-4 py-px font-mono text-xs leading-6 text-white"
          >
            {line}
          </div>
        ),
      )}
    </>
  );
}

export function LogModal({
  podName,
  namespace,
  jobName,
  repoFullName,
  status,
  prompt,
  tokens,
  onClose,
  onRetriggered,
}: {
  podName: string;
  namespace: string;
  jobName?: string;
  repoFullName?: string;
  // Pod phase of the task, used to offer a re-run for a Failed/cancelled one.
  status?: string;
  prompt: string | null;
  tokens?: TokenUsage | null;
  onClose: () => void;
  // Called with the new run's job name once a retrigger succeeds, so the
  // dashboard can surface the fresh task and close this (now stale) log view.
  onRetriggered?: (jobName: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  // A finished-but-unsuccessful task can be re-run from here (needs its job
  // name to look the original up server-side).
  const canRetrigger = status === "Failed" && !!jobName;
  const retrigger = api.agents.retrigger.useMutation({
    onSuccess: (result) => onRetriggered?.(result.jobName),
  });
  // How many trailing lines to fetch; grows as the user scrolls up.
  const [limit, setLimit] = useState(INITIAL_LINES);
  // Whether we're stuck to the newest line (live-follow).
  const [pinned, setPinned] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);
  const prevLimit = useRef(INITIAL_LINES);
  const loadingMore = useRef(false);

  function copyPrompt() {
    if (!prompt) return;
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const {
    data: logs,
    isLoading,
    error,
  } = api.agents.getLogs.useQuery(
    { podName, namespace, jobName, repoFullName, tailLines: limit },
    // Live-follow only while pinned to the bottom; pausing while scrolled up
    // keeps the history stable instead of the tail window sliding underneath.
    { refetchInterval: pinned ? 5000 : false },
  );

  const lineCount = logs ? logs.split("\n").length : 0;
  // A full window likely means older lines exist beyond what we fetched.
  const hasMore = lineCount >= limit && limit < MAX_LINES;

  // After each render: keep the viewport stable when older lines prepend, or
  // stick to the bottom when following live output.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !logs) return;
    if (limit !== prevLimit.current) {
      prevLimit.current = limit;
      loadingMore.current = false;
      // Older lines just prepended: keep the bottom pinned while live-following,
      // otherwise hold the viewport on the content the user was reading.
      if (pinned) el.scrollTop = el.scrollHeight;
      else el.scrollTop += el.scrollHeight - prevScrollHeight.current;
    } else if (pinned) {
      el.scrollTop = el.scrollHeight;
    }
    // An in-flight pod's tail often collapses (folded tool output, subagent
    // blocks) into content too short to overflow the viewport — leaving no
    // scrollbar, so handleScroll's load-more never fires and the rest of the
    // log is never fetched. Keep pulling older pages until the viewport can
    // scroll (or the log is exhausted / capped), so history fills in without a
    // manual scroll the user has no room to perform.
    if (
      !loadingMore.current &&
      hasMore &&
      el.scrollHeight - el.clientHeight < 40
    ) {
      loadingMore.current = true;
      prevScrollHeight.current = el.scrollHeight;
      setLimit((l) => Math.min(l + PAGE_LINES, MAX_LINES));
    }
  }, [logs, limit, pinned, hasMore]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== pinned) setPinned(atBottom);
    // Near the top → pull in an older page.
    if (el.scrollTop < 40 && hasMore && !loadingMore.current) {
      loadingMore.current = true;
      prevScrollHeight.current = el.scrollHeight;
      setLimit((l) => Math.min(l + PAGE_LINES, MAX_LINES));
    }
  }

  function jumpToLatest() {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  const segments = logs ? parseSegments(logs) : [];

  return (
    <Modal
      onClose={onClose}
      panelClassName="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]"
      headerClassName="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 py-3"
      titleAccessory={
        <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-sm text-purple-300">
          {podName}
        </code>
      }
      headerActions={
        <>
          <TokenReadout tokens={tokens} className="text-xs" />
          <span className="flex items-center gap-1.5 text-xs text-white/40">
            <span
              className={`h-1.5 w-1.5 rounded-full ${pinned ? "bg-green-400" : "bg-white/30"}`}
            />
            {pinned ? "Live" : "Paused"}
          </span>
          {canRetrigger && (
            <button
              type="button"
              onClick={() => {
                if (jobName)
                  retrigger.mutate({ namespace, jobName, repoFullName });
              }}
              disabled={retrigger.isPending}
              title={
                retrigger.error?.message ?? "Run this task again as a new task"
              }
              className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                className={`h-3.5 w-3.5 ${retrigger.isPending ? "animate-spin" : ""}`}
              >
                <path d="M13.65 2.35a.75.75 0 0 0-1.28.53v1.2A6 6 0 1 0 14 8a.75.75 0 0 0-1.5 0A4.5 4.5 0 1 1 11.2 4.8h-1.32a.75.75 0 0 0 0 1.5h2.9a.75.75 0 0 0 .75-.75v-2.9a.75.75 0 0 0-.22-.53Z" />
              </svg>
              {retrigger.isPending ? "Retriggering…" : "Retrigger"}
            </button>
          )}
        </>
      }
    >
      {/* Prompt */}
      {prompt && (
        <div className="border-b border-white/10 px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium tracking-wider text-white/40 uppercase">
              Prompt
            </span>
            <button
              onClick={copyPrompt}
              className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 hover:text-white"
            >
              {copied ? (
                "Copied ✓"
              ) : (
                <>
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                  >
                    <path d="M10 1.5H6a.5.5 0 0 0-.5.5v1H4.5A1.5 1.5 0 0 0 3 5v8.5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-1V2a.5.5 0 0 0-.5-.5Zm0 2V5h1.5a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H6v-1h4Z" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="max-h-32 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap text-white/55">
            {prompt}
          </pre>
        </div>
      )}

      {/* Body */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-auto p-4"
        >
          {isLoading && (
            <p className="font-mono text-xs text-white/30">Loading…</p>
          )}
          {error && (
            <p className="font-mono text-xs text-red-400">{error.message}</p>
          )}
          {!isLoading && !error && segments.length === 0 && (
            <p className="font-mono text-xs text-white/30">No logs yet.</p>
          )}
          {!isLoading &&
            (hasMore ? (
              <p className="pb-2 text-center font-mono text-[11px] text-white/20">
                Scroll up for older lines…
              </p>
            ) : segments.length > 0 ? (
              <p className="pb-2 text-center font-mono text-[11px] text-white/15">
                — start of log —
              </p>
            ) : null)}
          {segments.map((seg, i) =>
            seg.kind === "harness" ? (
              <HarnessSegment key={i} lines={seg.lines} />
            ) : seg.kind === "user" ? (
              <UserSegment key={i} lines={seg.lines} />
            ) : (
              <ClaudeSegment key={i} lines={seg.lines} />
            ),
          )}
        </div>

        {/* Jump-to-latest appears when scrolled away from the live tail. */}
        {!pinned && (
          <button
            onClick={jumpToLatest}
            className="absolute right-4 bottom-4 flex items-center gap-1 rounded-full border border-white/15 bg-[var(--surface-panel)] px-3 py-1.5 text-xs text-white/80 shadow-lg hover:brightness-125"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path d="M8 11.5a.75.75 0 0 1-.53-.22l-4-4a.75.75 0 1 1 1.06-1.06L8 9.69l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-.53.22Z" />
            </svg>
            Jump to latest
          </button>
        )}
      </div>
    </Modal>
  );
}
