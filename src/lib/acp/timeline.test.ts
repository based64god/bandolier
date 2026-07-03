import { describe, expect, it } from "vitest";

import {
  applyFrames,
  batchAwaitsInput,
  END_SESSION_FRAME,
  groupTimeline,
  promptFrame,
  type RawAcpFrame,
  type TimelineItem,
} from "./timeline";

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
        kind: "edit",
        title: "Edit: src/app.ts",
        status: "pending",
      },
    ]);
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
    groups.map((g) => (g.type === "tools" ? g.items.length : "msg"));

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
