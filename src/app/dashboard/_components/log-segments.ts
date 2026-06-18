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
