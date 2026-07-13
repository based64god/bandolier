import { describe, expect, it } from "vitest";

import {
  groupHarnessBlocks,
  harnessOutputText,
  harnessSubagentText,
  parseSegments,
  SUBAGENT_MARKER,
  SUBAGENT_SEP,
} from "~/app/dashboard/_components/log-segments";

// Builds a subagent-tagged harness line the way the Go harness writes it:
// [harness] ⇉ <label> ⟫ <body>.
const subLine = (label: string, body: string) =>
  `[harness] ${SUBAGENT_MARKER} ${label} ${SUBAGENT_SEP} ${body}`;

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

  it("folds a subagent's run into one labelled block", () => {
    const lines = [
      "12:00:01 [harness] → Agent(Explore): find auth",
      subLine("Agent(Explore): find auth", "→ Grep: login"),
      subLine("Agent(Explore): find auth", "  ← src/auth.ts"),
      "12:00:02 [harness] claude finished (turns=1)",
    ];
    expect(groupHarnessBlocks(lines)).toEqual([
      { kind: "line", text: "12:00:01 [harness] → Agent(Explore): find auth" },
      {
        kind: "subagent",
        label: "Agent(Explore): find auth",
        lines: ["→ Grep: login", "  ← src/auth.ts"],
      },
      { kind: "line", text: "12:00:02 [harness] claude finished (turns=1)" },
    ]);
  });

  it("keeps distinct subagents in separate blocks", () => {
    const lines = [
      subLine("Agent(Explore): a", "→ Read a.ts"),
      subLine("Agent(Plan): b", "→ Read b.ts"),
    ];
    expect(
      groupHarnessBlocks(lines).filter((b) => b.kind === "subagent"),
    ).toEqual([
      { kind: "subagent", label: "Agent(Explore): a", lines: ["→ Read a.ts"] },
      { kind: "subagent", label: "Agent(Plan): b", lines: ["→ Read b.ts"] },
    ]);
  });

  it("gathers interleaved parallel subagents into one block each (not per line)", () => {
    // Two background subagents whose lines alternate on the stream — the shape a
    // wide ultracode fan-out produces. Adjacency-only grouping (the old behaviour)
    // would fragment this into five separate blocks; first-seen bucketing keeps
    // each subagent's lines together in the block at its first-seen position.
    const lines = [
      subLine("Agent(Explore): a", "→ Read a.ts"),
      subLine("Agent(Plan): b", "→ Read b.ts"),
      subLine("Agent(Explore): a", "  ← alpha"),
      subLine("Agent(Plan): b", "  ← beta"),
      subLine("Agent(Explore): a", "done exploring"),
    ];
    expect(
      groupHarnessBlocks(lines).filter((b) => b.kind === "subagent"),
    ).toEqual([
      {
        kind: "subagent",
        label: "Agent(Explore): a",
        lines: ["→ Read a.ts", "  ← alpha", "done exploring"],
      },
      {
        kind: "subagent",
        label: "Agent(Plan): b",
        lines: ["→ Read b.ts", "  ← beta"],
      },
    ]);
  });

  it("keeps a main-agent line/output run between two runs of the same subagent in order", () => {
    // A subagent line, then a main-agent tool call + output, then more of the same
    // subagent: the subagent's lines still gather into its first-seen block while
    // the main-agent line and output block keep their stream position.
    const lines = [
      subLine("Agent(Explore): a", "→ Grep: login"),
      "[harness] → Bash: git status",
      "[harness]   ← On branch main",
      subLine("Agent(Explore): a", "  ← src/auth.ts"),
    ];
    expect(groupHarnessBlocks(lines)).toEqual([
      {
        kind: "subagent",
        label: "Agent(Explore): a",
        lines: ["→ Grep: login", "  ← src/auth.ts"],
      },
      { kind: "line", text: "[harness] → Bash: git status" },
      { kind: "output", lines: ["On branch main"] },
    ]);
  });
});

describe("harnessSubagentText", () => {
  it("splits the label and body of a subagent line", () => {
    expect(
      harnessSubagentText(
        subLine("Agent(Explore): find auth", "→ Grep: login"),
      ),
    ).toEqual({ label: "Agent(Explore): find auth", text: "→ Grep: login" });
  });

  it("tolerates the harness timestamp prefix", () => {
    expect(
      harnessSubagentText(`12:00:01 ${subLine("Agent(x): y", "→ Read z")}`),
    ).toEqual({ label: "Agent(x): y", text: "→ Read z" });
  });

  it("returns null for a plain, output, or tool-call harness line", () => {
    expect(harnessSubagentText("[harness] → Bash: git status")).toBeNull();
    expect(harnessSubagentText("[harness]   ← output")).toBeNull();
    expect(harnessSubagentText("a plain claude line")).toBeNull();
  });
});
