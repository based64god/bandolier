import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "~/server/better-auth";
import { savePushSubscription } from "~/server/push";

const bodySchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

// Re-persists a push subscription after the browser rotates it. The service
// worker's `pushsubscriptionchange` handler fires while the app may be closed
// (no page to run the tRPC mutation), so it re-subscribes and POSTs here. The
// session cookie rides along on the same-origin fetch, identifying the user.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid subscription" },
      { status: 400 },
    );
  }

  await savePushSubscription(session.user.id, parsed.data);
  return NextResponse.json({ ok: true });
}
