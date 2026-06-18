import { describe, expect, it } from "vitest";

import { parseSegments } from "~/app/dashboard/_components/log-segments";

describe("parseSegments", () => {
  it("classifies harness, user, and claude lines", () => {
    const raw = [
      "12:00:01 [harness] cloning repo",
      "12:00:02 [user] fix the bug",
      "Sure, I'll take a look.",
    ].join("\n");

    expect(parseSegments(raw)).toEqual([
      { kind: "harness", lines: ["12:00:01 [harness] cloning repo"] },
      { kind: "user", lines: ["fix the bug"] },
      { kind: "claude", lines: ["Sure, I'll take a look."] },
    ]);
  });

  it("groups consecutive lines of the same kind", () => {
    const raw = [
      "12:00:01 [harness] one",
      "12:00:02 [harness] two",
      "first claude line",
      "second claude line",
    ].join("\n");

    const segments = parseSegments(raw);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind).toBe("harness");
    expect(segments[0]?.lines).toHaveLength(2);
    expect(segments[1]?.kind).toBe("claude");
    expect(segments[1]?.lines).toEqual([
      "first claude line",
      "second claude line",
    ]);
  });

  it("strips the [user] tag and its leading timestamp", () => {
    const segments = parseSegments("15:04:05 [user] hello there");
    expect(segments).toEqual([{ kind: "user", lines: ["hello there"] }]);
  });

  it("keeps a multi-line user message as one grouped segment", () => {
    const raw = ["10:00:00 [user] line one", "10:00:00 [user] line two"].join(
      "\n",
    );
    expect(parseSegments(raw)).toEqual([
      { kind: "user", lines: ["line one", "line two"] },
    ]);
  });

  it("does not treat a mid-line [user] tag in Claude's output as user input", () => {
    // Claude quoting the marker should render as its own (claude) output, since
    // real content precedes the tag rather than just a harness timestamp.
    const line = 'The harness logs "[user] hi" for each message.';
    expect(parseSegments(line)).toEqual([{ kind: "claude", lines: [line] }]);
  });
});
