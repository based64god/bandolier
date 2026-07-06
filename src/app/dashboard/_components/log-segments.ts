// Pure parsing for the streamed transcript shown in the log modal and the
// interactive session card. Splits the raw pod log into typed segments so the
// renderers can dim harness diagnostics, set the user's own messages apart, and
// foreground Claude's output. Kept free of React so it's unit-testable.

export type Segment = {
  kind: "harness" | "claude" | "user";
  lines: string[];
};

// Marks transcript lines carrying a user's interactive message. Kept in sync
// with the harness (userInputMarker) and the agents router (USER_MARKER). The
// prefix is stripped when rendering so the bubble shows just the message.
export const USER_PREFIX = "[user] ";

// Locates the "[user]" tag in a log line, allowing for the timestamp the harness
// prepends (e.g. "15:04:05 [user] hi"). Returns -1 when the line isn't tagged.
function userTagIndex(line: string): number {
  const i = line.indexOf(USER_PREFIX);
  // Only the harness timestamp (or nothing) may precede the tag — guard against
  // a stray "[user] " appearing mid-line in Claude's own output.
  return i >= 0 && /^[\d:.\s]*$/.test(line.slice(0, i)) ? i : -1;
}

// Groups consecutive log lines by source so runs of [harness] diagnostics can be
// collapsed away, and the user's own messages render distinctly from Claude's
// responses.
export function parseSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  for (const line of raw.split("\n")) {
    const userAt = userTagIndex(line);
    const kind: Segment["kind"] =
      userAt >= 0 ? "user" : line.includes("[harness]") ? "harness" : "claude";
    // Strip everything up to and including the "[user] " tag so the bubble shows
    // just the message text, not the harness timestamp/prefix.
    const text = userAt >= 0 ? line.slice(userAt + USER_PREFIX.length) : line;
    const last = segments[segments.length - 1];
    if (last?.kind === kind) {
      last.lines.push(text);
    } else {
      segments.push({ kind, lines: [text] });
    }
  }
  return segments;
}

// Within a harness segment, the harness marks each line of a tool call's
// captured output (stdout/stderr) with this arrow immediately after the
// [harness] tag — the output counterpart to the → that prefixes a tool call.
// Kept in sync with the harness (logToolResult in providers_claude.go), which
// writes the bytes this parser reads back.
export const OUTPUT_MARKER = "←";

const HARNESS_TAG = "[harness]";

// The tool-output content of a harness line, or null when the line isn't one. A
// line qualifies when — after its [harness] tag and the harness's own
// indentation — it begins with OUTPUT_MARKER. The marker and the single space
// the harness writes after it are stripped, so the tool's own indentation is
// preserved.
export function harnessOutputText(line: string): string | null {
  const tag = line.indexOf(HARNESS_TAG);
  if (tag < 0) return null;
  const after = line.slice(tag + HARNESS_TAG.length).replace(/^\s+/, "");
  if (!after.startsWith(OUTPUT_MARKER)) return null;
  return after.slice(OUTPUT_MARKER.length).replace(/^ /, "");
}

// A harness segment renders as a run of blocks: plain diagnostic lines pass
// through, while consecutive tool-output lines collapse into a single `output`
// block the modal hides behind a nested expander — so a call's result doesn't
// flood the already-collapsed harness fold. Mirrors how the interactive
// transcript expands a tool call's result on its own row.
export type HarnessBlock =
  | { kind: "line"; text: string }
  | { kind: "output"; lines: string[] };

export function groupHarnessBlocks(lines: string[]): HarnessBlock[] {
  const blocks: HarnessBlock[] = [];
  for (const line of lines) {
    const out = harnessOutputText(line);
    if (out === null) {
      blocks.push({ kind: "line", text: line });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "output") last.lines.push(out);
    else blocks.push({ kind: "output", lines: [out] });
  }
  return blocks;
}
