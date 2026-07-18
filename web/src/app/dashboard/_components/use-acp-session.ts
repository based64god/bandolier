"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyFrames,
  END_SESSION_FRAME,
  promptFrame,
  type AvailableCommand,
  type TimelineItem,
} from "~/lib/acp/timeline";
import { api } from "~/trpc/react";

const POLL_INTERVAL_MS = 1500;

// A collision-proof token identifying one hook instance's prompts. The relay
// broadcasts every session/prompt frame to *all* connected clients, and each
// client dedupes its own optimistically-rendered prompts by id — so an id space
// shared between clients would let one client swallow another's turn. Prefixing
// every id with a fresh random token per instance keeps a client's ids unique
// across both concurrent clients and page reloads. Uses crypto.randomUUID where
// available (all modern browsers), with a Math.random fallback for older or
// non-secure contexts.
function newClientToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

/**
 * Drives the frontend's side of an interactive ACP session over the HTTP relay.
 * It polls agents.acpPull for the session's frames, folds them into a chat
 * timeline, captures the session id, and exposes sendPrompt/endSession which
 * enqueue client→agent frames via agents.acpSend. The harness proxy establishes
 * and seeds the session, so this attaches to a running session rather than
 * performing the handshake itself.
 *
 * Polls only while `enabled` (wire it to the row being expanded). A collapsed
 * session stops polling entirely — its waiting/notification state comes from the
 * separate agents.list query, and expanding replays the full backlog from the
 * cursor — so we don't hit the relay for conversations no one is looking at.
 * When the session is no longer `running`, the backlog is drained once and
 * polling stops on the first empty batch: the frames are durable, so a finished
 * session replays its whole conversation instead of showing nothing.
 */
export function useAcpSession({
  namespace,
  jobName,
  repoFullName,
  running,
  enabled,
}: {
  namespace: string;
  jobName: string;
  repoFullName?: string;
  running: boolean;
  enabled: boolean;
}) {
  const utils = api.useUtils();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<string[]>([]);

  const itemsRef = useRef<TimelineItem[]>([]);
  const cursorRef = useRef(0);
  // Per-instance namespace + counter for the JSON-RPC ids of the prompts this
  // client sends. The relay broadcasts every session/prompt frame to *all*
  // connected clients (multiple tabs, the same user on two devices), and each
  // client dedupes its own optimistically-rendered prompts against
  // `sentPromptIds` by id. A global id space let two clients pick the same id,
  // so one would wrongly swallow the other's prompt — the session dropped turns
  // whenever more than one client was connected. The random per-instance token
  // (minted lazily in sendPrompt so render stays pure) makes a client's ids
  // unique across concurrent clients *and* page reloads, so its dedup set can
  // never match another client's — or an earlier visit's replayed — frames.
  const clientTokenRef = useRef("");
  const nextIdRef = useRef(0);
  // Ids of prompts sent by this instance, whose bubbles were already rendered
  // optimistically — applyFrames skips these when their frames come back
  // around on the next pull.
  const sentPromptIdsRef = useRef(new Set<string>());

  // Poll for agent→client frames while the session is live. A manual loop (vs.
  // a useQuery keyed by the cursor) keeps the advancing cursor from churning
  // react-query keys on every batch.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let drained = false;
    const tick = async () => {
      try {
        const res = await utils.agents.acpPull.fetch(
          {
            namespace,
            jobName,
            repoFullName,
            cursor: cursorRef.current,
          },
          // Bypass the global 30s staleTime. fetch() is react-query's
          // fetchQuery; between batches the cursor doesn't change, so every tick
          // reuses the same query key and would be served the cached (usually
          // empty) result for 30s — the chat would sit a turn behind. We poll
          // only while expanded (see `enabled`), so re-fetching each tick is
          // cheap and scoped to the conversation on screen.
          { staleTime: 0 },
        );
        if (!active) return;
        if (res.frames.length === 0) {
          // A finished session's backlog is fully drained and no new frames
          // can arrive, so stop polling; the timeline stays as the replayed
          // conversation.
          if (!running) drained = true;
          return;
        }
        cursorRef.current = res.cursor;
        const {
          items: next,
          sessionId: sid,
          commands: cmds,
          backgroundTasks: bg,
        } = applyFrames(itemsRef.current, res.frames, sentPromptIdsRef.current);
        itemsRef.current = next;
        setItems(next);
        if (sid) setSessionId(sid);
        if (cmds) setCommands(cmds);
        // A batch without a background-tasks frame leaves `bg` undefined; keep the
        // previous set then. An empty array is a real drain, so set it.
        if (bg !== undefined) setBackgroundTasks(bg);
      } catch {
        // transient; retry on the next tick
      }
    };
    void tick();
    const handle = setInterval(() => {
      if (drained) {
        clearInterval(handle);
        return;
      }
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [enabled, running, namespace, jobName, repoFullName, utils]);

  const send = api.agents.acpSend.useMutation();

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;
      if (!clientTokenRef.current) clientTokenRef.current = newClientToken();
      const id = `${clientTokenRef.current}-${nextIdRef.current++}`;
      const frame = promptFrame(sessionId, id, trimmed);
      // Optimistically show the user's turn; recording the id lets applyFrames
      // skip this prompt's frame when the pull loop sees it, so the bubble
      // isn't duplicated.
      sentPromptIdsRef.current.add(id);
      const next: TimelineItem[] = [
        ...itemsRef.current,
        {
          type: "message",
          role: "user",
          id: `local-${id}`,
          text: trimmed,
        },
      ];
      itemsRef.current = next;
      setItems(next);
      send.mutate({ namespace, jobName, repoFullName, frame });
    },
    [sessionId, namespace, jobName, repoFullName, send],
  );

  const endSession = useCallback(() => {
    send.mutate({ namespace, jobName, repoFullName, frame: END_SESSION_FRAME });
  }, [namespace, jobName, repoFullName, send]);

  return {
    items,
    /** Slash commands the agent advertised, or [] until one is seen. */
    commands,
    /**
     * The live set of background subagent task ids, or [] when none are in
     * flight. Drives the pinned background-tasks indicator.
     */
    backgroundTasks,
    /** True once the session id is known and a prompt can be sent. */
    ready: !!sessionId,
    sendPrompt,
    sendError: send.error?.message ?? null,
    sendPending: send.isPending,
    endSession,
  };
}
