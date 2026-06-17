"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";

// Lines fetched initially (enough to fill the modal) and per scroll-up page.
const INITIAL_LINES = 100;
const PAGE_LINES = 200;
const MAX_LINES = 10000;

type Segment = { kind: "harness" | "claude"; lines: string[] };

// Groups consecutive log lines by source so runs of [harness] diagnostics can be
// collapsed away from Claude's output.
function parseSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  for (const line of raw.split("\n")) {
    const kind: Segment["kind"] = line.includes("[harness]")
      ? "harness"
      : "claude";
    const last = segments[segments.length - 1];
    if (last?.kind === kind) {
      last.lines.push(line);
    } else {
      segments.push({ kind, lines: [line] });
    }
  }
  return segments;
}

function HarnessSegment({ lines }: { lines: string[] }) {
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
        <span className="font-mono text-xs">
          {lines.length} diagnostic {lines.length === 1 ? "line" : "lines"}
        </span>
      </summary>
      <div className="mt-0.5 ml-4 border-l border-white/10 pl-3">
        {lines.map((line, i) => (
          <div
            key={i}
            className="font-mono text-xs leading-5 break-all text-white/25"
          >
            {line}
          </div>
        ))}
      </div>
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
  prompt,
  onClose,
}: {
  podName: string;
  namespace: string;
  jobName?: string;
  repoFullName?: string;
  prompt: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
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
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
      prevLimit.current = limit;
      loadingMore.current = false;
    } else if (pinned) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs, limit, pinned]);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Lock background scrolling while the modal is open so only the logs scroll.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const segments = logs ? parseSegments(logs) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/20 bg-[#0a0a1a]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
          <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-sm text-purple-300">
            {podName}
          </code>
          <div className="flex shrink-0 items-center gap-3 pl-2">
            <span className="flex items-center gap-1.5 text-xs text-white/40">
              <span
                className={`h-1.5 w-1.5 rounded-full ${pinned ? "bg-green-400" : "bg-white/30"}`}
              />
              {pinned ? "Live" : "Paused"}
            </span>
            <button
              onClick={onClose}
              className="text-white/40 hover:text-white"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

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
              ) : (
                <ClaudeSegment key={i} lines={seg.lines} />
              ),
            )}
          </div>

          {/* Jump-to-latest appears when scrolled away from the live tail. */}
          {!pinned && (
            <button
              onClick={jumpToLatest}
              className="absolute right-4 bottom-4 flex items-center gap-1 rounded-full border border-white/15 bg-[#1a1a30] px-3 py-1.5 text-xs text-white/80 shadow-lg hover:bg-[#24244a]"
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
      </div>
    </div>
  );
}
