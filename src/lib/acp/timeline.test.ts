import { describe, expect, it } from "vitest";

import {
  applyFrames,
  END_SESSION_FRAME,
  promptFrame,
  type RawAcpFrame,
  type TimelineItem,
} from "./timeline";

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
