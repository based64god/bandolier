import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { env } from "~/env";
import { verifyIngestToken } from "~/lib/ingest";
import { db } from "~/server/db";
import { taskRun } from "~/server/db/schema";
import { sendPushToUser, webPushEnabled } from "~/server/agents/web-push";

// Harness callback: the agent posts lifecycle events (it finished, failed, or
// is waiting for the user) so the server can deliver a Web Push notification to
// the owning user's devices — the path that works when no Bandolier tab is open.
// Authenticated by the same per-job HMAC token as the artifact/input callbacks
// (the harness can't hold a session) and exempt from the password gate.

const eventSchema = z.object({
  // What happened. Mirrors the in-tab alert triggers (completion + awaiting
  // input) so background and foreground notifications stay consistent.
  type: z.enum(["succeeded", "failed", "awaiting-input"]),
});

// Human-facing copy per event type. `tag` collapses repeats for the same job so
// a flaky poll can't stack duplicate notifications.
function payloadFor(type: z.infer<typeof eventSchema>["type"], label: string) {
  switch (type) {
    case "succeeded":
      return { title: "Agent finished", body: label, tag: "complete" };
    case "failed":
      return { title: "Agent failed", body: label, tag: "complete" };
    case "awaiting-input":
      return {
        title: "Agent waiting for input",
        body: label,
        tag: "await",
      };
  }
}

export async function POST(req: NextRequest) {
  // Nothing to deliver without a configured VAPID keypair — accept and no-op so
  // the harness doesn't treat a push-less deployment as an error.
  if (!webPushEnabled()) {
    return NextResponse.json({ ok: true, delivered: 0 });
  }

  const jobName = req.headers.get("x-bandolier-job");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !jobName ||
    !token ||
    !verifyIngestToken(jobName, token, env.BETTER_AUTH_SECRET)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = eventSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Resolve which user owns this job so we know whose devices to notify.
  const [run] = await db
    .select({ userId: taskRun.userId, displayName: taskRun.displayName })
    .from(taskRun)
    .where(eq(taskRun.jobName, jobName))
    .limit(1);

  if (!run?.userId) {
    // No owner mapping (e.g. run row pruned) — nothing to notify, but the token
    // verified, so this isn't an error from the harness's side.
    return NextResponse.json({ ok: true, delivered: 0 });
  }

  const { title, body, tag } = payloadFor(parsed.data.type, run.displayName);
  const delivered = await sendPushToUser(run.userId, {
    title,
    body,
    tag: `${tag}:${jobName}`,
    url: "/",
  });

  return NextResponse.json({ ok: true, delivered });
}
