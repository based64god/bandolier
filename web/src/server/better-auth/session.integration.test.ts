import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auth } from "~/server/better-auth";
import { session as sessionTable, user as userTable } from "~/server/db/schema";
import { db, resetDb } from "~/test/integration/harness";

// Validates the better-auth ↔ drizzle-adapter wiring against a real Postgres:
// email/password sign-up mints a session, the signed cookie resolves back to the
// user via getSession, and the user/session rows actually land. This is also the
// foundation the browser e2e reuses: it produces the exact signed cookie a
// Playwright context can carry, so the e2e auth bypass needs no OAuth and no
// reverse-engineering of cookie signing.
describe("better-auth email/password session lifecycle (real Postgres)", () => {
  beforeEach(resetDb);

  it("sign-up mints a session cookie that getSession resolves to the user", async () => {
    const email = "alice@test.local";
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Alice" },
      asResponse: true,
    });
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) =>
      c.startsWith("better-auth.session_token="),
    );
    expect(sessionCookie, "sign-up should set a session cookie").toBeTruthy();
    const cookieHeader = sessionCookie!.split(";")[0]!;

    // The signed cookie resolves back to the user with no further credentials.
    const resolved = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });
    expect(resolved?.user.email).toBe(email);
    expect(resolved?.user.name).toBe("Alice");

    // The rows are really in Postgres.
    const [u] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.email, email));
    expect(u).toBeTruthy();
    const sessions = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.userId, u!.id));
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("rejects a bogus session cookie", async () => {
    const resolved = await auth.api.getSession({
      headers: new Headers({
        cookie: "better-auth.session_token=forged.not-a-real-token",
      }),
    });
    expect(resolved).toBeNull();
  });
});
