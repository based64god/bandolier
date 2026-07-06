import { describe, expect, it } from "vitest";

import {
  groupHarnessBlocks,
  harnessOutputText,
  parseSegments,
} from "~/app/dashboard/_components/log-segments";

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

describe("harnessOutputText", () => {
  it("returns the tool output text for a ←-tagged harness line", () => {
    expect(harnessOutputText("12:00:01 [harness]   ← On branch main")).toBe(
      "On branch main",
    );
  });

  it("strips the marker and its single space but keeps the tool's indentation", () => {
    // The harness writes "[harness]   ← " then the raw output line; only that one
    // trailing space is the marker's — any further indentation is the tool's.
    expect(harnessOutputText("[harness]   ←   two-space indent")).toBe(
      "  two-space indent",
    );
  });

  it("returns null for tool-call and plain lines", () => {
    expect(harnessOutputText("[harness] → Bash: git status")).toBeNull();
    expect(harnessOutputText("12:00:01 [harness] cloning repo")).toBeNull();
    expect(harnessOutputText("a plain claude line")).toBeNull();
  });
});

describe("groupHarnessBlocks", () => {
  it("folds a run of tool-output lines into one output block", () => {
    const lines = [
      "12:00:01 [harness] → Bash: git status",
      "12:00:01 [harness]   ← On branch main",
      "12:00:01 [harness]   ← nothing to commit",
      "12:00:02 [harness] claude finished (turns=1)",
    ];
    expect(groupHarnessBlocks(lines)).toEqual([
      { kind: "line", text: "12:00:01 [harness] → Bash: git status" },
      { kind: "output", lines: ["On branch main", "nothing to commit"] },
      { kind: "line", text: "12:00:02 [harness] claude finished (turns=1)" },
    ]);
  });

  it("keeps separate calls' outputs as separate blocks", () => {
    const lines = [
      "[harness] → Read a.ts",
      "[harness]   ← alpha",
      "[harness] → Read b.ts",
      "[harness]   ← beta",
    ];
    expect(
      groupHarnessBlocks(lines).filter((b) => b.kind === "output"),
    ).toEqual([
      { kind: "output", lines: ["alpha"] },
      { kind: "output", lines: ["beta"] },
    ]);
  });
});
