"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyFrames,
  END_SESSION_FRAME,
  promptFrame,
  type TimelineItem,
} from "~/lib/acp/timeline";
import { api } from "~/trpc/react";

const POLL_INTERVAL_MS = 1500;

/**
 * Drives the frontend's side of an interactive ACP session over the HTTP relay.
 * It polls agents.acpPull for agent→client frames, folds them into a chat
 * timeline, captures the session id, and exposes sendPrompt/endSession which
 * enqueue client→agent frames via agents.acpSend. The harness proxy establishes
 * and seeds the session, so this attaches to a running session rather than
 * performing the handshake itself.
 */
export function useAcpSession({
  namespace,
  jobName,
  repoFullName,
  running,
}: {
  namespace: string;
  jobName: string;
  repoFullName?: string;
  running: boolean;
}) {
  const utils = api.useUtils();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  const itemsRef = useRef<TimelineItem[]>([]);
  const cursorRef = useRef(0);
  const nextIdRef = useRef(1);

  // Poll for agent→client frames while the session is live. A manual loop (vs.
  // a useQuery keyed by the cursor) keeps the advancing cursor from churning
  // react-query keys on every batch.
  useEffect(() => {
    if (!running) return;
    let active = true;
    const tick = async () => {
      try {
        const res = await utils.agents.acpPull.fetch({
          namespace,
          jobName,
          repoFullName,
          cursor: cursorRef.current,
        });
        if (!active || res.frames.length === 0) return;
        cursorRef.current = res.cursor;
        const { items: next, sessionId: sid } = applyFrames(
          itemsRef.current,
          res.frames,
        );
        itemsRef.current = next;
        setItems(next);
        if (sid) setSessionId(sid);
      } catch {
        // transient; retry on the next tick
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [running, namespace, jobName, repoFullName, utils]);

  const send = api.agents.acpSend.useMutation();

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;
      const frame = promptFrame(sessionId, nextIdRef.current++, trimmed);
      // Optimistically show the user's turn. The proxy only echoes the seed
      // prompt, not follow-ups, so this is the sole source for follow-up bubbles
      // (no duplication).
      const next: TimelineItem[] = [
        ...itemsRef.current,
        {
          type: "message",
          role: "user",
          id: `local-${nextIdRef.current}`,
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
    /** True once the session id is known and a prompt can be sent. */
    ready: !!sessionId,
    sendPrompt,
    sendError: send.error?.message ?? null,
    sendPending: send.isPending,
    endSession,
  };
}
