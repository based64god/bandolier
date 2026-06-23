import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { verifyIngestToken } from "~/lib/ingest";
import { db } from "~/server/db";
import { acpFrame } from "~/server/db/schema";

// Harness ACP relay. The in-pod proxy drives this with the same per-job HMAC
// token as the artifact ingest (it can't hold a session) and it's exempt from
// the password gate.
//
//   GET  → claim the queued client→agent frames (initialize/session.new/prompt/
//          cancel + control frames), marking them delivered so they're consumed
//          once. Returns 200 `{ frames: [{ seq, payload }] }` oldest-first, or
//          204 when the queue is empty.
//   POST → append agent→client frames (`{ frames: string[] }`, each a raw
//          JSON-RPC frame) for the frontend to poll.

// Cap how many client→agent frames a single poll claims, so one poll can't drain
// an unbounded backlog into memory.
const PULL_LIMIT = 200;

function authorize(req: NextRequest): string | null {
  const jobName = req.headers.get("x-bandolier-job");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !jobName ||
    !token ||
    !verifyIngestToken(jobName, token, env.BETTER_AUTH_SECRET)
  ) {
    return null;
  }
  return jobName;
}

export async function GET(req: NextRequest) {
  const jobName = authorize(req);
  if (!jobName) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({ seq: acpFrame.seq, payload: acpFrame.payload })
    .from(acpFrame)
    .where(
      and(
        eq(acpFrame.jobName, jobName),
        eq(acpFrame.direction, "c2a"),
        isNull(acpFrame.deliveredAt),
      ),
    )
    .orderBy(asc(acpFrame.seq))
    .limit(PULL_LIMIT);

  if (rows.length === 0) return new NextResponse(null, { status: 204 });

  // A single harness polls per job, so marking the claimed rows delivered is
  // enough to make delivery exactly-once without a transaction.
  await db
    .update(acpFrame)
    .set({ deliveredAt: new Date() })
    .where(
      inArray(
        acpFrame.seq,
        rows.map((r) => r.seq),
      ),
    );

  return NextResponse.json({ frames: rows });
}

export async function POST(req: NextRequest) {
  const jobName = authorize(req);
  if (!jobName) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let frames: unknown;
  try {
    ({ frames } = (await req.json()) as { frames?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(frames) || frames.some((f) => typeof f !== "string")) {
    return NextResponse.json(
      { error: "frames must be an array of strings" },
      { status: 400 },
    );
  }
  if (frames.length === 0) return NextResponse.json({ ok: true });

  await db.insert(acpFrame).values(
    (frames as string[]).map((payload) => ({
      jobName,
      direction: "a2c",
      payload,
    })),
  );
  return NextResponse.json({ ok: true });
}
