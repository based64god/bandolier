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
      { type: "message", role: "assistant", id: "m1", text: "working" },
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
