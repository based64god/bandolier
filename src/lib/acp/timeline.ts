// Pure helpers for turning the ACP frame stream into a chat timeline the
// interactive UI renders. Kept free of React so it can be unit tested in
// isolation.

export type TimelineItem =
  | {
      type: "message";
      role: "user" | "assistant";
      // Always-unique React key. NOT the messageId — the agent reuses one
      // messageId for a whole turn, so several bubbles can share it.
      id: string;
      // Set on assistant bubbles, for coalescing consecutive chunks of the same
      // message. Undefined for user bubbles.
      messageId?: string;
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

/** A slash command advertised by the agent via available_commands_update. */
export interface AvailableCommand {
  name: string;
  description?: string;
}

interface ParsedUpdate {
  sessionUpdate?: string;
  messageId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: { text?: string };
  availableCommands?: AvailableCommand[];
}

interface ParsedFrame {
  id?: number | string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: ParsedUpdate;
    prompt?: { text?: string }[];
  };
}

/**
 * Folds a batch of relay frames (both directions, seq-ordered) into the
 * timeline, returning the new items and the session id if one was observed.
 * Assistant message chunks that share a messageId are coalesced into a single
 * bubble; tool calls become their own rows; user_message_chunk frames (the
 * proxy's seed echo) become user bubbles. The user's follow-up turns exist in
 * the relay only as their client→agent session/prompt frames, so those render
 * as user bubbles too — that's what makes a replay (page reload, or reopening
 * a finished session) show both sides of the conversation. Prompts whose
 * JSON-RPC id is in `sentPromptIds` are skipped: this client instance already
 * rendered them optimistically when it sent them. An
 * available_commands_update surfaces the session's slash commands (for the
 * input's typeahead) rather than a timeline item. Other frames (responses,
 * cancels, control frames) are ignored for rendering — only their sessionId is
 * harvested.
 */
export function applyFrames(
  prev: TimelineItem[],
  frames: RawAcpFrame[],
  sentPromptIds?: ReadonlySet<number | string>,
): {
  items: TimelineItem[];
  sessionId?: string;
  /** Present only when an available_commands_update was seen in this batch. */
  commands?: AvailableCommand[];
} {
  const items = [...prev];
  let sessionId: string | undefined;
  let commands: AvailableCommand[] | undefined;

  for (const f of frames) {
    let msg: ParsedFrame;
    try {
      msg = JSON.parse(f.payload) as ParsedFrame;
    } catch {
      continue;
    }
    if (msg.params?.sessionId) sessionId = msg.params.sessionId;
    if (msg.method === "session/prompt") {
      if (msg.id !== undefined && sentPromptIds?.has(msg.id)) continue;
      const text = (msg.params?.prompt ?? [])
        .map((p) => p?.text ?? "")
        .join("");
      if (text) {
        items.push({ type: "message", role: "user", id: `u-${f.seq}`, text });
      }
      continue;
    }
    if (msg.method !== "session/update" || !msg.params?.update) continue;

    const u = msg.params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.text ?? "";
        if (!text) break;
        const last = items[items.length - 1];
        // Coalesce only with the immediately-preceding bubble of the same
        // message. A tool call (or a new messageId) starts a fresh bubble — and
        // it gets its own unique `id`, since chunks split by a tool call share a
        // messageId and reusing it as the React key collides.
        if (
          u.messageId &&
          last?.type === "message" &&
          last.role === "assistant" &&
          last.messageId === u.messageId
        ) {
          items[items.length - 1] = { ...last, text: last.text + text };
        } else {
          items.push({
            type: "message",
            role: "assistant",
            id: `a-${f.seq}`,
            messageId: u.messageId,
            text,
          });
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
      case "available_commands_update": {
        // Keep only well-formed entries; the latest update wins (it replaces the
        // list rather than appending), matching how an agent re-advertises.
        commands = (u.availableCommands ?? []).filter((c) => c?.name);
        break;
      }
    }
  }

  return { items, sessionId, commands };
}

/**
 * A run of timeline items ready to render: message bubbles pass through as-is,
 * while consecutive tool calls are gathered into a single `tools` group so the
 * UI can collapse them behind a summary — the interactive mirror of how the
 * non-interactive log collapses runs of [harness] diagnostic lines.
 */
export type TimelineGroup =
  | {
      type: "message";
      id: string;
      item: Extract<TimelineItem, { type: "message" }>;
    }
  | {
      type: "tools";
      id: string;
      items: Extract<TimelineItem, { type: "tool" }>[];
    };

/**
 * Collapses runs of consecutive tool calls in the timeline into `tools` groups,
 * leaving messages as standalone groups. Keeps the folding pure and unit-testable,
 * mirroring parseSegments for the non-interactive log.
 */
export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    if (item.type === "tool") {
      const last = groups[groups.length - 1];
      if (last?.type === "tools") {
        last.items.push(item);
      } else {
        groups.push({ type: "tools", id: item.id, items: [item] });
      }
    } else {
      groups.push({ type: "message", id: item.id, item });
    }
  }
  return groups;
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
