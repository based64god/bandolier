// Pure helpers for turning the agent→client ACP frame stream into a chat
// timeline the interactive UI renders. Kept free of React so it can be unit
// tested in isolation.

export type TimelineItem =
  | {
      type: "message";
      role: "user" | "assistant";
      id: string;
      text: string;
    }
  | {
      type: "tool";
      id: string;
      kind: string;
      title: string;
      status: string;
    };

export interface RawAcpFrame {
  seq: number;
  payload: string;
}

interface ParsedUpdate {
  sessionUpdate?: string;
  messageId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: { text?: string };
}

interface ParsedFrame {
  method?: string;
  params?: { sessionId?: string; update?: ParsedUpdate };
}

/**
 * Folds a batch of agent→client frames into the timeline, returning the new
 * items and the session id if one was observed. Assistant message chunks that
 * share a messageId are coalesced into a single bubble; tool calls become their
 * own rows; user_message_chunk frames (the proxy's seed echo) become user
 * bubbles. Frames that aren't session/update notifications (responses, etc.) are
 * ignored for rendering — only their sessionId is harvested.
 */
export function applyFrames(
  prev: TimelineItem[],
  frames: RawAcpFrame[],
): { items: TimelineItem[]; sessionId?: string } {
  const items = [...prev];
  let sessionId: string | undefined;

  for (const f of frames) {
    let msg: ParsedFrame;
    try {
      msg = JSON.parse(f.payload) as ParsedFrame;
    } catch {
      continue;
    }
    if (msg.params?.sessionId) sessionId = msg.params.sessionId;
    if (msg.method !== "session/update" || !msg.params?.update) continue;

    const u = msg.params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.text ?? "";
        if (!text) break;
        const id = u.messageId ?? `a-${f.seq}`;
        const last = items[items.length - 1];
        if (
          last?.type === "message" &&
          last.role === "assistant" &&
          last.id === id
        ) {
          items[items.length - 1] = { ...last, text: last.text + text };
        } else {
          items.push({ type: "message", role: "assistant", id, text });
        }
        break;
      }
      case "user_message_chunk": {
        const text = u.content?.text ?? "";
        if (!text) break;
        items.push({ type: "message", role: "user", id: `u-${f.seq}`, text });
        break;
      }
      case "tool_call": {
        items.push({
          type: "tool",
          id: `t-${f.seq}`,
          kind: u.kind ?? "other",
          title: u.title ?? "",
          status: u.status ?? "pending",
        });
        break;
      }
    }
  }

  return { items, sessionId };
}

/** Builds a session/prompt JSON-RPC frame for the frontend client to enqueue. */
export function promptFrame(
  sessionId: string,
  id: number,
  text: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  });
}

/**
 * Control frame that ends the session. The harness proxy consumes it (rather
 * than forwarding it to the agent) and runs its post-run PR/issue step.
 */
export const END_SESSION_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  method: "_bandolier/endSession",
});
