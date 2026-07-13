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

  const itemsRef = useRef<TimelineItem[]>([]);
  const cursorRef = useRef(0);
  // JSON-RPC ids for the prompts this instance sends. Seeded with the epoch
  // (lazily, in sendPrompt — render must stay pure) rather than 1 so ids never
  // collide across page reloads: replayed session/prompt frames are deduped
  // against `sentPromptIds` by id, and a reload that reused ids 1, 2, … would
  // wrongly swallow an earlier visit's replayed turns.
  const nextIdRef = useRef(0);
  // Ids of prompts sent by this instance, whose bubbles were already rendered
  // optimistically — applyFrames skips these when their frames come back
  // around on the next pull.
  const sentPromptIdsRef = useRef(new Set<number>());

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
        } = applyFrames(itemsRef.current, res.frames, sentPromptIdsRef.current);
        itemsRef.current = next;
        setItems(next);
        if (sid) setSessionId(sid);
        if (cmds) setCommands(cmds);
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
      if (nextIdRef.current === 0) nextIdRef.current = Date.now();
      const id = nextIdRef.current++;
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
    /** True once the session id is known and a prompt can be sent. */
    ready: !!sessionId,
    sendPrompt,
    sendError: send.error?.message ?? null,
    sendPending: send.isPending,
    endSession,
  };
}
