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
      // The agent-assigned tool_call id, used to match a later
      // tool_call_update back to this call. Undefined for tool calls whose
      // source omitted one (e.g. the codex driver).
      toolCallId?: string;
      // The tool_call id of the subagent-spawning Agent/Task call this call ran
      // inside (from the harness's ACP extension). Undefined for main-agent
      // calls. Used to nest a subagent's calls under their spawn — see
      // buildToolTree.
      parentToolCallId?: string;
      kind: string;
      title: string;
      status: string;
      // The tool's output, accumulated from tool_call_update frames. Rendered
      // as a nested expander in the UI so a call's result doesn't flood the row.
      output?: string;
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

/** One block of a tool_call_update's `content` array. */
interface ToolContentBlock {
  content?: { text?: string };
}

interface ParsedUpdate {
  sessionUpdate?: string;
  messageId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  // An object `{text}` for message chunks; an array of blocks for
  // tool_call_update. Narrowed per-case via chunkText / toolOutputText.
  content?: { text?: string } | ToolContentBlock[];
  availableCommands?: AvailableCommand[];
}

/** Text of a message chunk's content, ignoring the tool_call_update array form. */
function chunkText(content: ParsedUpdate["content"]): string {
  return content && !Array.isArray(content) ? (content.text ?? "") : "";
}

/** Concatenated text of a tool_call_update's content blocks. */
function toolOutputText(content: ParsedUpdate["content"]): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.content?.text ?? "").join("");
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
 * bubble; tool calls become their own rows, with any tool_call_update frames
 * folded into the matching row as its output; user_message_chunk frames (the
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
        const text = chunkText(u.content);
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
        const text = chunkText(u.content);
        if (!text) break;
        items.push({ type: "message", role: "user", id: `u-${f.seq}`, text });
        break;
      }
      case "tool_call": {
        items.push({
          type: "tool",
          id: `t-${f.seq}`,
          toolCallId: u.toolCallId,
          parentToolCallId: u.parentToolCallId,
          kind: u.kind ?? "other",
          title: u.title ?? "",
          status: u.status ?? "pending",
        });
        break;
      }
      case "tool_call_update": {
        // Attach the tool's output (and updated status) to its originating
        // call, matched by toolCallId. A batch may carry several updates for
        // one call, so accumulate rather than replace. Ignored if no matching
        // call is in the timeline (e.g. the update arrived before its call).
        if (!u.toolCallId) break;
        const output = toolOutputText(u.content);
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it?.type === "tool" && it.toolCallId === u.toolCallId) {
            items[i] = {
              ...it,
              status: u.status ?? it.status,
              output: output ? (it.output ?? "") + output : it.output,
            };
            break;
          }
        }
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
export type ToolItem = Extract<TimelineItem, { type: "tool" }>;

/**
 * A tool call plus any calls that ran inside it — the render tree for a subagent
 * spawn (a `subagent`-kind call) and its nested tool calls. Main-agent calls are
 * leaf nodes (no children).
 */
export interface ToolNode {
  item: ToolItem;
  children: ToolNode[];
}

export type TimelineGroup =
  | {
      type: "message";
      id: string;
      item: Extract<TimelineItem, { type: "message" }>;
    }
  | {
      type: "tools";
      id: string;
      nodes: ToolNode[];
    };

/**
 * Nests a run of tool calls into a forest: a call whose parentToolCallId matches
 * an earlier call's toolCallId becomes that call's child (a subagent's calls
 * under their spawn), at arbitrary depth. Calls with no in-run parent — main
 * agent calls, and orphans whose parent isn't in this run — stay roots, so
 * nothing is dropped. Grouping by id (not adjacency) is what survives parallel
 * subagents interleaving their calls on one stream.
 */
export function buildToolTree(items: ToolItem[]): ToolNode[] {
  const byId = new Map<string, ToolNode>();
  const roots: ToolNode[] = [];
  for (const item of items) {
    const node: ToolNode = { item, children: [] };
    if (item.toolCallId) byId.set(item.toolCallId, node);
    const parent = item.parentToolCallId
      ? byId.get(item.parentToolCallId)
      : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Collapses runs of consecutive tool calls in the timeline into `tools` groups,
 * leaving messages as standalone groups. Within each group, subagent calls nest
 * under their spawn (buildToolTree). Keeps the folding pure and unit-testable,
 * mirroring parseSegments for the non-interactive log.
 */
export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const runs: (ToolItem[] | Extract<TimelineItem, { type: "message" }>)[] = [];
  for (const item of items) {
    if (item.type === "tool") {
      const last = runs[runs.length - 1];
      if (Array.isArray(last)) last.push(item);
      else runs.push([item]);
    } else {
      runs.push(item);
    }
  }
  return runs.map((run) =>
    Array.isArray(run)
      ? { type: "tools", id: run[0]!.id, nodes: buildToolTree(run) }
      : { type: "message", id: run.id, item: run },
  );
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

/**
 * True when a batch of agent→client frames contains a completed prompt turn —
 * a JSON-RPC response carrying `result.stopReason`. That's the protocol-level
 * "the agent finished its turn and now awaits the user", the same transition
 * the log-scanning await detection keys off. A `cancelled` stop is excluded:
 * the user just cancelled, so there's nothing to alert them about. Used
 * server-side to fire a background "waiting for input" push as turns end.
 */
export function batchAwaitsInput(frames: string[]): boolean {
  for (const raw of frames) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== "object") continue;
    const result = (msg as { result?: { stopReason?: unknown } }).result;
    const stopReason = result?.stopReason;
    if (typeof stopReason === "string" && stopReason !== "cancelled") {
      return true;
    }
  }
  return false;
}
