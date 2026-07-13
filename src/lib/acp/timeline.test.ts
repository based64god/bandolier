import { describe, expect, it } from "vitest";

import {
  applyFrames,
  batchAwaitsInput,
  buildToolTree,
  collectSubagentCards,
  collectSubagentNarration,
  collectSubagentStatuses,
  END_SESSION_FRAME,
  isSubagentDone,
  groupTimeline,
  promptFrame,
  type RawAcpFrame,
  type TimelineItem,
  type ToolItem,
  type ToolNode,
} from "./timeline";

// Iterative depth/count so these probes never overflow themselves, even if the
// tree under test were pathologically deep (the very failure they guard against).
function treeDepth(nodes: ToolNode[]): number {
  let max = 0;
  const stack = nodes.map((node) => ({ node, d: 1 }));
  while (stack.length) {
    const { node, d } = stack.pop()!;
    if (d > max) max = d;
    for (const c of node.children) stack.push({ node: c, d: d + 1 });
  }
  return max;
}
function treeCount(nodes: ToolNode[]): number {
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    n++;
    for (const c of node.children) stack.push(c);
  }
  return n;
}

function promptResult(id: number, stopReason: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } });
}

function update(seq: number, sessionId: string, update: unknown): RawAcpFrame {
  return {
    seq,
    payload: JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    }),
  };
}

describe("applyFrames", () => {
  it("captures the session id from any session/update frame", () => {
    const { sessionId } = applyFrames(
      [],
      [
        update(1, "sess-1", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "hi" },
        }),
      ],
    );
    expect(sessionId).toBe("sess-1");
  });

  it("renders user and assistant messages and tool calls in order", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "user_message_chunk",
          content: { text: "do it" },
        }),
        update(2, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "working" },
        }),
        update(3, "s", {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "edit",
          title: "Edit: src/app.ts",
          status: "pending",
        }),
      ],
    );
    expect(items).toEqual<TimelineItem[]>([
      { type: "message", role: "user", id: "u-1", text: "do it" },
      {
        type: "message",
        role: "assistant",
        id: "a-2",
        messageId: "m1",
        text: "working",
      },
      {
        type: "tool",
        id: "t-3",
        toolCallId: "t1",
        kind: "edit",
        title: "Edit: src/app.ts",
        status: "pending",
      },
    ]);
  });

  it("attaches a tool_call_update's output and status to its originating call", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          kind: "execute",
          title: "Bash: ls",
          status: "pending",
        }),
        update(2, "s", {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "a.ts\n" } },
          ],
        }),
        update(3, "s", {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          content: [
            { type: "content", content: { type: "text", text: "b.ts" } },
          ],
        }),
      ],
    );
    expect(items).toEqual<TimelineItem[]>([
      {
        type: "tool",
        id: "t-1",
        toolCallId: "tc-1",
        kind: "execute",
        title: "Bash: ls",
        status: "completed",
        output: "a.ts\nb.ts",
      },
    ]);
  });

  it("ignores a tool_call_update with no matching call", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "tool_call_update",
          toolCallId: "missing",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "x" } }],
        }),
      ],
    );
    expect(items).toEqual([]);
  });

  it("coalesces assistant chunks sharing a messageId into one bubble", () => {
    const first = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "Hello " },
        }),
      ],
    );
    const { items } = applyFrames(first.items, [
      update(2, "s", {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { text: "world" },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "Hello world", role: "assistant" });
  });

  it("gives distinct keys to same-message bubbles split by a tool call", () => {
    // The agent reuses one messageId for a whole turn, so text before and after
    // a tool call shares it. Each bubble must still get a unique id (React key),
    // or the later bubbles collide and don't render.
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "reading" },
        }),
        update(2, "s", {
          sessionUpdate: "tool_call",
          kind: "read",
          title: "Read: a.ts",
        }),
        update(3, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "done" },
        }),
      ],
    );
    expect(items).toHaveLength(3);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3); // all keys unique
    expect(items[0]).toMatchObject({ type: "message", text: "reading" });
    expect(items[2]).toMatchObject({ type: "message", text: "done" });
  });

  it("starts a new bubble when the messageId changes", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "one" },
        }),
        update(2, "s", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m2",
          content: { text: "two" },
        }),
      ],
    );
    expect(items.map((i) => (i.type === "message" ? i.text : ""))).toEqual([
      "one",
      "two",
    ]);
  });

  it("surfaces available_commands_update as the commands list, not a timeline item", () => {
    const { items, commands } = applyFrames(
      [],
      [
        update(1, "sess-1", {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "code-review", description: "Review the diff" },
            { name: "verify" },
          ],
        }),
      ],
    );
    expect(items).toEqual([]);
    expect(commands).toEqual([
      { name: "code-review", description: "Review the diff" },
      { name: "verify" },
    ]);
  });

  it("drops malformed command entries (missing name)", () => {
    const { commands } = applyFrames(
      [],
      [
        update(1, "sess-1", {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "ok" }, { description: "no name" }, {}],
        }),
      ],
    );
    expect(commands).toEqual([{ name: "ok" }]);
  });

  it("lets the latest available_commands_update replace the previous list", () => {
    const { commands } = applyFrames(
      [],
      [
        update(1, "sess-1", {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "old" }],
        }),
        update(2, "sess-1", {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "new" }],
        }),
      ],
    );
    expect(commands).toEqual([{ name: "new" }]);
  });

  it("leaves commands undefined when no update was seen", () => {
    const { commands } = applyFrames(
      [],
      [
        update(1, "sess-1", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "hi" },
        }),
      ],
    );
    expect(commands).toBeUndefined();
  });

  it("renders a replayed session/prompt frame as a user bubble", () => {
    const { items, sessionId } = applyFrames(
      [],
      [
        { seq: 4, payload: promptFrame("sess-1", 7, "follow-up question") },
        update(5, "sess-1", {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { text: "answer" },
        }),
      ],
    );
    expect(items).toEqual<TimelineItem[]>([
      { type: "message", role: "user", id: "u-4", text: "follow-up question" },
      {
        type: "message",
        role: "assistant",
        id: "a-5",
        messageId: "m1",
        text: "answer",
      },
    ]);
    expect(sessionId).toBe("sess-1");
  });

  it("concatenates a prompt's text blocks into one user bubble", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s",
        prompt: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    });
    const { items } = applyFrames([], [{ seq: 1, payload }]);
    expect(items).toEqual([
      { type: "message", role: "user", id: "u-1", text: "part one part two" },
    ]);
  });

  it("skips session/prompt frames whose id was sent by this client", () => {
    // The sender already rendered its own prompt optimistically; replaying its
    // frame must not duplicate the bubble, while other prompts still render.
    const { items } = applyFrames(
      [],
      [
        { seq: 1, payload: promptFrame("s", 41, "mine, already shown") },
        { seq: 2, payload: promptFrame("s", 42, "from before the reload") },
      ],
      new Set([41]),
    );
    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        id: "u-2",
        text: "from before the reload",
      },
    ]);
  });

  it("ignores non-update frames (responses) but still harvests their nothing", () => {
    const { items, sessionId } = applyFrames(
      [],
      [
        {
          seq: 1,
          payload:
            '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
        },
        { seq: 2, payload: "not json" },
      ],
    );
    expect(items).toEqual([]);
    expect(sessionId).toBeUndefined();
  });

  it("drops agent message chunks with empty or missing content", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", { sessionUpdate: "agent_message_chunk", content: {} }),
        update(2, "s", { sessionUpdate: "agent_message_chunk" }),
      ],
    );
    expect(items).toEqual([]);
  });

  it("does not coalesce assistant chunks that lack a messageId", () => {
    // Without a messageId there is nothing to coalesce on: each chunk gets its
    // own bubble and its own seq-derived key.
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          content: { text: "a" },
        }),
        update(2, "s", {
          sessionUpdate: "agent_message_chunk",
          content: { text: "b" },
        }),
      ],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "message",
      role: "assistant",
      id: "a-1",
      text: "a",
    });
    expect(items[1]).toMatchObject({ id: "a-2", text: "b" });
    for (const item of items) {
      expect(item.type === "message" && item.messageId).toBeUndefined();
    }
  });

  it("drops user message chunks with empty text", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "user_message_chunk",
          content: { text: "" },
        }),
      ],
    );
    expect(items).toEqual([]);
  });

  it("fills tool_call fallbacks: kind 'other', empty title, pending status", () => {
    const { items } = applyFrames(
      [],
      [update(1, "s", { sessionUpdate: "tool_call" })],
    );
    expect(items).toEqual([
      { type: "tool", id: "t-1", kind: "other", title: "", status: "pending" },
    ]);
  });

  it("yields an empty commands list when the update omits availableCommands", () => {
    // [] (agent advertises nothing) is distinct from undefined (no update seen).
    const { commands } = applyFrames(
      [],
      [update(1, "s", { sessionUpdate: "available_commands_update" })],
    );
    expect(commands).toEqual([]);
  });

  it("renders no bubble for a session/prompt without a prompt array but keeps its session id", () => {
    const { items, sessionId } = applyFrames(
      [],
      [
        {
          seq: 1,
          payload: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/prompt",
            params: { sessionId: "s" },
          }),
        },
      ],
    );
    expect(items).toEqual([]);
    expect(sessionId).toBe("s");
  });

  it("renders no bubble for a prompt whose text blocks are all empty", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "" }] },
    });
    const { items } = applyFrames([], [{ seq: 1, payload }]);
    expect(items).toEqual([]);
  });

  it("renders an id-less session/prompt even when sentPromptIds is provided", () => {
    // Only prompts whose JSON-RPC id matches a sent one are skipped; a frame
    // with no id at all can't have been sent by this client.
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] },
    });
    const { items } = applyFrames([], [{ seq: 3, payload }], new Set([1]));
    expect(items).toEqual([
      { type: "message", role: "user", id: "u-3", text: "hi" },
    ]);
  });

  it("ignores unknown session update types but still harvests the session id", () => {
    const { items, sessionId } = applyFrames(
      [],
      [update(1, "sess-1", { sessionUpdate: "plan", entries: [] })],
    );
    expect(items).toEqual([]);
    expect(sessionId).toBe("sess-1");
  });

  it("skips a session/update frame with no update payload but keeps its session id", () => {
    const { items, sessionId } = applyFrames(
      [],
      [
        {
          seq: 1,
          payload: JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "s" },
          }),
        },
      ],
    );
    expect(items).toEqual([]);
    expect(sessionId).toBe("s");
  });
});

describe("groupTimeline", () => {
  const msg = (id: string, text: string): TimelineItem => ({
    type: "message",
    role: "assistant",
    id,
    text,
  });
  const tool = (id: string): TimelineItem => ({
    type: "tool",
    id,
    kind: "read",
    title: `Read ${id}`,
    status: "pending",
  });

  const toolCounts = (groups: ReturnType<typeof groupTimeline>) =>
    groups.map((g) => (g.type === "tools" ? g.nodes.length : "msg"));

  it("collapses a run of consecutive tool calls into one group", () => {
    const groups = groupTimeline([
      msg("a1", "reading"),
      tool("t1"),
      tool("t2"),
      tool("t3"),
      msg("a2", "done"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ type: "message", id: "a1" });
    expect(groups[1]).toMatchObject({ type: "tools", id: "t1" });
    expect(groups[2]).toMatchObject({ type: "message", id: "a2" });
    expect(toolCounts(groups)).toEqual(["msg", 3, "msg"]);
  });

  it("keeps a lone tool call as its own group", () => {
    const groups = groupTimeline([msg("a1", "one"), tool("t1")]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ type: "tools", id: "t1" });
    expect(toolCounts(groups)).toEqual(["msg", 1]);
  });

  it("starts a fresh group after a message interrupts the tool run", () => {
    const groups = groupTimeline([
      tool("t1"),
      tool("t2"),
      msg("a1", "between"),
      tool("t3"),
    ]);
    expect(toolCounts(groups)).toEqual([2, "msg", 1]);
  });

  it("returns nothing for an empty timeline", () => {
    expect(groupTimeline([])).toEqual([]);
  });

  const toolWith = (
    id: string,
    toolCallId: string,
    parentToolCallId?: string,
  ): TimelineItem => ({
    type: "tool",
    id,
    toolCallId,
    parentToolCallId,
    kind: parentToolCallId ? "read" : "subagent",
    title: id,
    status: "pending",
  });

  it("nests a subagent's calls under their spawn", () => {
    const groups = groupTimeline([
      toolWith("t1", "agent1"),
      toolWith("t2", "sub1", "agent1"),
      toolWith("t3", "sub2", "agent1"),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    // One root (the spawn) with two nested children.
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.item.toolCallId).toBe("agent1");
    expect(g.nodes[0]!.children.map((c) => c.item.toolCallId)).toEqual([
      "sub1",
      "sub2",
    ]);
  });

  it("nests grandchildren under a nested subagent (depth > 1)", () => {
    const groups = groupTimeline([
      toolWith("t1", "agent1"),
      toolWith("t2", "agent2", "agent1"),
      toolWith("t3", "leaf", "agent2"),
    ]);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    expect(g.nodes[0]!.children[0]!.item.toolCallId).toBe("agent2");
    expect(g.nodes[0]!.children[0]!.children[0]!.item.toolCallId).toBe("leaf");
  });

  it("keeps two parallel subagents' interleaved calls under the right parent", () => {
    const groups = groupTimeline([
      toolWith("t1", "agentA"),
      toolWith("t2", "agentB"),
      toolWith("t3", "a1", "agentA"),
      toolWith("t4", "b1", "agentB"),
      toolWith("t5", "a2", "agentA"),
    ]);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    const byId = new Map(g.nodes.map((n) => [n.item.toolCallId, n]));
    expect(byId.get("agentA")!.children.map((c) => c.item.toolCallId)).toEqual([
      "a1",
      "a2",
    ]);
    expect(byId.get("agentB")!.children.map((c) => c.item.toolCallId)).toEqual([
      "b1",
    ]);
  });

  it("renders an orphan child (parent absent) as a root, dropping nothing", () => {
    const groups = groupTimeline([toolWith("t1", "sub1", "missing")]);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.item.toolCallId).toBe("sub1");
  });

  it("nests a subagent's child under its spawn across an interleaved main-agent message", () => {
    // The background/ultracode shape: the main agent narrates (a message) between
    // the Agent spawn and the subagent's later tool call, splitting the adjacency
    // run. The child must still nest under its spawn, not re-root as a top-level
    // call — the failure the whole-timeline forest fixes. (The parallel-subagent
    // test above has no interleaved message, so it never exercised this.)
    const groups = groupTimeline([
      toolWith("t1", "agent1"),
      msg("a1", "dispatched an explorer"),
      toolWith("t2", "sub1", "agent1"),
    ]);
    // The message still splits the flow into its own group, in stream order…
    expect(groups.map((g) => g.type)).toEqual(["tools", "message"]);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    // …but the child nests under its spawn (which streamed before the message)
    // rather than orphaning into a second top-level tool run after it.
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.item.toolCallId).toBe("agent1");
    expect(g.nodes[0]!.children.map((c) => c.item.toolCallId)).toEqual([
      "sub1",
    ]);
  });

  it("gathers a subagent's calls under one spawn across several interleaved messages", () => {
    // Two background subagents, each interrupted by main-agent narration and the
    // other's calls — the calls scatter across runs but must gather under the
    // right spawn, and the messages keep their own groups in order.
    const groups = groupTimeline([
      toolWith("t1", "agentA"),
      toolWith("t2", "agentB"),
      msg("m1", "both dispatched"),
      toolWith("t3", "a1", "agentA"),
      toolWith("t4", "b1", "agentB"),
      msg("m2", "still going"),
      toolWith("t5", "a2", "agentA"),
    ]);
    expect(groups.map((g) => g.type)).toEqual(["tools", "message", "message"]);
    const g = groups[0];
    if (g?.type !== "tools") throw new Error("expected tools group");
    const byId = new Map(g.nodes.map((n) => [n.item.toolCallId, n]));
    expect(byId.get("agentA")!.children.map((c) => c.item.toolCallId)).toEqual([
      "a1",
      "a2",
    ]);
    expect(byId.get("agentB")!.children.map((c) => c.item.toolCallId)).toEqual([
      "b1",
    ]);
  });
});

describe("collectSubagentStatuses / collectSubagentCards", () => {
  const spawn = (
    toolCallId: string,
    title: string,
    status: string,
  ): TimelineItem => ({
    type: "tool",
    id: `t-${toolCallId}`,
    toolCallId,
    kind: "subagent",
    title,
    status,
  });
  const narrate = (parentToolCallId: string, text: string): TimelineItem => ({
    type: "subagent-log",
    id: `s-${parentToolCallId}-${text}`,
    parentToolCallId,
    variant: "message",
    text,
  });

  it("counts a spawned-but-silent subagent that narration alone would miss", () => {
    const items: TimelineItem[] = [
      spawn("agentA", "Agent(Explore): find auth", "pending"),
      spawn("agentB", "Agent(Plan): sketch fix", "pending"),
    ];
    expect(collectSubagentStatuses(items)).toEqual([
      {
        toolCallId: "agentA",
        label: "Agent(Explore): find auth",
        status: "pending",
      },
      {
        toolCallId: "agentB",
        label: "Agent(Plan): sketch fix",
        status: "pending",
      },
    ]);
    // The under-count the card fix addresses: no narration ⇒ no cards, the old way.
    expect(collectSubagentNarration(items)).toEqual([]);
  });

  it("reflects the spawn's latest status", () => {
    const items: TimelineItem[] = [
      spawn("agentA", "Agent(Explore)", "completed"),
    ];
    expect(collectSubagentStatuses(items)[0]!.status).toBe("completed");
  });

  it("merges spawn status with narration entries, silent spawns included", () => {
    const items: TimelineItem[] = [
      spawn("agentA", "Agent(Explore): find auth", "pending"),
      spawn("agentB", "Agent(Plan): sketch fix", "pending"),
      narrate("agentA", "found it"),
    ];
    const cards = collectSubagentCards(items);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      toolCallId: "agentA",
      status: "pending",
      entries: [{ variant: "message", text: "found it" }],
    });
    expect(cards[1]).toMatchObject({ toolCallId: "agentB", entries: [] });
  });

  it("keeps an orphan subagent that narrated with no spawn in view", () => {
    const cards = collectSubagentCards([narrate("ghost", "orphan narration")]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCallId: "ghost", label: "subagent" });
  });

  it("returns nothing for a session with no subagents", () => {
    expect(collectSubagentStatuses([])).toEqual([]);
    expect(collectSubagentCards([])).toEqual([]);
  });
});

describe("buildToolTree depth cap", () => {
  it("keeps genuine nesting intact (well under the cap)", () => {
    const item = (
      id: string,
      toolCallId: string,
      parentToolCallId?: string,
    ): ToolItem => ({
      type: "tool",
      id,
      toolCallId,
      parentToolCallId,
      kind: parentToolCallId ? "read" : "subagent",
      title: id,
      status: "pending",
    });
    const roots = buildToolTree([
      item("t1", "a0"),
      item("t2", "a1", "a0"),
      item("t3", "leaf", "a1"),
    ]);
    expect(treeDepth(roots)).toBe(3);
    expect(treeCount(roots)).toBe(3);
  });

  it("bounds depth for a reused-id parent chain so the render walk can't overflow", () => {
    // A pathological run a background workflow could produce: two tool-call ids
    // reused forever, each call parented on the previous. Without a cap this
    // builds a tree thousands deep and the recursive render (ToolNodeRow) /
    // count (countNodes) walk blows the stack — crashing the whole conversation.
    const items: ToolItem[] = [
      {
        type: "tool",
        id: "t-0",
        toolCallId: "A",
        kind: "execute",
        title: "root",
        status: "pending",
      },
    ];
    let prev = "A";
    for (let i = 1; i < 4000; i++) {
      const toolCallId = i % 2 === 0 ? "A" : "B";
      items.push({
        type: "tool",
        id: `t-${i}`,
        toolCallId,
        parentToolCallId: prev,
        kind: "execute",
        title: `step ${i}`,
        status: "pending",
      });
      prev = toolCallId;
    }
    const roots = buildToolTree(items);
    // Depth is bounded (cap + 1); the recursive render/count walk stays shallow.
    expect(treeDepth(roots)).toBeLessThanOrEqual(26);
    // Nothing is dropped — every call still appears somewhere in the forest.
    expect(treeCount(roots)).toBe(4000);
  });
});

describe("subagent narration", () => {
  it("routes a tagged message/thought to subagent-log, not the conversation", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          content: { text: "main answer" },
        }),
        update(2, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "agent1",
          content: { text: "sub says " },
        }),
        update(3, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "agent1",
          content: { text: "hi" },
        }),
        update(4, "s", {
          sessionUpdate: "agent_thought_chunk",
          parentToolCallId: "agent1",
          content: { text: "hmm" },
        }),
      ],
    );
    // Main answer stays a conversation bubble; subagent chunks coalesce by
    // variant into subagent-log items kept out of the main flow.
    expect(items).toEqual<TimelineItem[]>([
      { type: "message", role: "assistant", id: "a-1", text: "main answer" },
      {
        type: "subagent-log",
        id: "s-2",
        parentToolCallId: "agent1",
        variant: "message",
        text: "sub says hi",
      },
      {
        type: "subagent-log",
        id: "s-4",
        parentToolCallId: "agent1",
        variant: "thinking",
        text: "hmm",
      },
    ]);
    // groupTimeline drops subagent-log from the rendered conversation flow.
    expect(groupTimeline(items).some((g) => g.type === "tools")).toBe(false);
    expect(groupTimeline(items)).toHaveLength(1);
  });

  it("drops the main agent's thinking (only subagents' is surfaced)", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_thought_chunk",
          content: { text: "main thinking" },
        }),
      ],
    );
    expect(items).toEqual([]);
  });

  it("collects narration per subagent, labelled from its spawn call", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "tool_call",
          toolCallId: "agentA",
          kind: "subagent",
          title: "Agent(Explore): find auth",
          status: "pending",
        }),
        update(2, "s", {
          sessionUpdate: "tool_call",
          toolCallId: "agentB",
          kind: "subagent",
          title: "Agent(Plan): sketch fix",
          status: "pending",
        }),
        update(3, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "agentA",
          content: { text: "found it" },
        }),
        update(4, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "agentB",
          content: { text: "planning" },
        }),
        update(5, "s", {
          sessionUpdate: "agent_thought_chunk",
          parentToolCallId: "agentA",
          content: { text: "considering" },
        }),
      ],
    );
    expect(collectSubagentNarration(items)).toEqual([
      {
        toolCallId: "agentA",
        label: "Agent(Explore): find auth",
        status: "pending",
        entries: [
          { variant: "message", text: "found it" },
          { variant: "thinking", text: "considering" },
        ],
      },
      {
        toolCallId: "agentB",
        label: "Agent(Plan): sketch fix",
        status: "pending",
        entries: [{ variant: "message", text: "planning" }],
      },
    ]);
  });

  it("falls back to a generic label when the spawn call isn't in view", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "ghost",
          content: { text: "orphan narration" },
        }),
      ],
    );
    const narration = collectSubagentNarration(items);
    expect(narration).toHaveLength(1);
    expect(narration[0]!.label).toBe("subagent");
  });

  it("returns nothing when no subagent narrated", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          content: { text: "just the main agent" },
        }),
      ],
    );
    expect(collectSubagentNarration(items)).toEqual([]);
  });

  it("reflects the spawn call's status, flipping to done when it completes", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "tool_call",
          toolCallId: "agentA",
          kind: "subagent",
          title: "Agent(Explore): find auth",
          status: "pending",
        }),
        update(2, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "agentA",
          content: { text: "found it" },
        }),
        update(3, "s", {
          sessionUpdate: "tool_call_update",
          toolCallId: "agentA",
          status: "completed",
        }),
      ],
    );
    const narration = collectSubagentNarration(items);
    expect(narration).toHaveLength(1);
    expect(narration[0]!.status).toBe("completed");
    expect(isSubagentDone(narration[0]!.status)).toBe(true);
  });

  it("defaults status to pending when the spawn call isn't in view", () => {
    const { items } = applyFrames(
      [],
      [
        update(1, "s", {
          sessionUpdate: "agent_message_chunk",
          parentToolCallId: "ghost",
          content: { text: "orphan narration" },
        }),
      ],
    );
    expect(collectSubagentNarration(items)[0]!.status).toBe("pending");
  });
});

describe("isSubagentDone", () => {
  it("is true only for terminal spawn-call statuses", () => {
    expect(isSubagentDone("completed")).toBe(true);
    expect(isSubagentDone("failed")).toBe(true);
    expect(isSubagentDone("pending")).toBe(false);
    expect(isSubagentDone("in_progress")).toBe(false);
  });
});

describe("frame builders", () => {
  it("builds a session/prompt frame", () => {
    const parsed = JSON.parse(promptFrame("sess-9", 3, "hi")) as {
      method: string;
      id: number;
      params: { sessionId: string; prompt: { type: string; text: string }[] };
    };
    expect(parsed.method).toBe("session/prompt");
    expect(parsed.id).toBe(3);
    expect(parsed.params.sessionId).toBe("sess-9");
    expect(parsed.params.prompt).toEqual([{ type: "text", text: "hi" }]);
  });

  it("end-session frame carries the bandolier control method", () => {
    const parsed = JSON.parse(END_SESSION_FRAME) as { method: string };
    expect(parsed.method).toBe("_bandolier/endSession");
  });
});

describe("batchAwaitsInput", () => {
  it("detects a completed prompt turn (end_turn)", () => {
    expect(batchAwaitsInput([promptResult(2, "end_turn")])).toBe(true);
  });

  it("treats any non-cancelled stop reason as awaiting input", () => {
    expect(batchAwaitsInput([promptResult(2, "max_tokens")])).toBe(true);
    expect(batchAwaitsInput([promptResult(2, "refusal")])).toBe(true);
  });

  it("ignores a cancelled turn (nothing to alert on)", () => {
    expect(batchAwaitsInput([promptResult(2, "cancelled")])).toBe(false);
  });

  it("ignores session/update notifications and other frames", () => {
    const chunk = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "hi" },
        },
      },
    });
    const sessionNew = JSON.stringify({ id: 1, result: { sessionId: "s1" } });
    expect(batchAwaitsInput([chunk, sessionNew])).toBe(false);
  });

  it("finds the turn-end frame among a mixed batch", () => {
    const chunk = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call" } },
    });
    expect(batchAwaitsInput([chunk, promptResult(3, "end_turn")])).toBe(true);
  });

  it("tolerates malformed frames", () => {
    expect(batchAwaitsInput(["not json", "{bad", ""])).toBe(false);
  });
});
