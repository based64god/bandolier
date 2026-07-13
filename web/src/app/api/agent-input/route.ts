import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import { verifyIngestToken } from "~/lib/ingest";
import { db } from "~/server/db";
import { agentInput } from "~/server/db/schema";

// Harness callback: an interactive agent polls this for the next queued user
// message. Authenticated by the same per-job HMAC token as the artifact ingest
// (the harness can't hold a session), and exempt from the password gate.
//
// Returns 200 `{ id, content }` for the oldest undelivered message (marking it
// delivered so it's consumed exactly once), or 204 when the queue is empty.
export async function GET(req: NextRequest) {
  const jobName = req.headers.get("x-bandolier-job");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !jobName ||
    !token ||
    !verifyIngestToken(jobName, token, env.BETTER_AUTH_SECRET)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [next] = await db
    .select({ id: agentInput.id })
    .from(agentInput)
    .where(and(eq(agentInput.jobName, jobName), isNull(agentInput.deliveredAt)))
    .orderBy(agentInput.createdAt)
    .limit(1);

  if (!next) return new NextResponse(null, { status: 204 });

  // Claim it (a single harness polls per job, so a guard is enough to make
  // delivery exactly-once without a transaction).
  const [claimed] = await db
    .update(agentInput)
    .set({ deliveredAt: new Date() })
    .where(and(eq(agentInput.id, next.id), isNull(agentInput.deliveredAt)))
    .returning({ id: agentInput.id, content: agentInput.content });

  if (!claimed) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ id: claimed.id, content: claimed.content });
}
