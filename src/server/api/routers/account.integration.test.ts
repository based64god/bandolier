import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AnthropicModule from "~/server/agents/anthropic";
import type * as OpenaiModule from "~/server/agents/openai";

// The account router's credential lifecycle against a REAL Postgres: the
// coexistence of the two Anthropic credential kinds on one row, the
// partial-column delete that NULLs one kind but keeps the row while the other
// remains (then DELETEs once the row is empty), the pure-DB compute setter, and
// the user-cascade that sweeps every user_* credential table. Only the *network*
// key validators the set* paths call are stubbed (they'd otherwise hit the
// provider APIs); every DB write runs for real. The OAuth-token format check
// stays real — the test just passes a well-formed token.
const validateAnthropicKey = vi
  .fn<() => Promise<{ valid: true }>>()
  .mockResolvedValue({ valid: true });
vi.mock("~/server/agents/anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof AnthropicModule>()),
  validateAnthropicKey: () => validateAnthropicKey(),
}));

const validateOpenaiKey = vi
  .fn<() => Promise<{ valid: true }>>()
  .mockResolvedValue({ valid: true });
vi.mock("~/server/agents/openai", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenaiModule>()),
  validateOpenaiKey: () => validateOpenaiKey(),
}));

const { accountRouter } = await import("~/server/api/routers/account");
const { createCallerFactory } = await import("~/server/api/trpc");
const {
  userAnthropicCredentials,
  userAwsCredentials,
  userCompute,
  userGeminiCredentials,
  userKubeconfig,
  userOpenaiCredentials,
} = await import("~/server/db/schema");
const { db, resetDb, testCtx } = await import("~/test/integration/harness");
const { seedUser } = await import("~/test/integration/seed");

const createCaller = createCallerFactory(accountRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

// A well-formed Claude Code OAuth token (real format check must pass): the
// `sk-ant-oat` prefix, no whitespace, [A-Za-z0-9_-], comfortably long.
const OAUTH_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345";

describe("account credential lifecycle (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    validateAnthropicKey.mockClear().mockResolvedValue({ valid: true });
    validateOpenaiKey.mockClear().mockResolvedValue({ valid: true });
  });

  it("setAnthropic then setAnthropicOauth coexist on the same row", async () => {
    const u = await seedUser();

    await caller(u).setAnthropic({ apiKey: "sk-ant-api-key" });
    await caller(u).setAnthropicOauth({ oauthToken: OAUTH_TOKEN });

    const rows = await db
      .select()
      .from(userAnthropicCredentials)
      .where(eq(userAnthropicCredentials.userId, u.id));
    // A single upserted row holds BOTH kinds — the second setter didn't clobber
    // the first (it targets the userId PK ON CONFLICT DO UPDATE its own column).
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKey).toBe("sk-ant-api-key");
    expect(rows[0]!.oauthToken).toBe(OAUTH_TOKEN);
  });

  it("deleteAnthropic({kind}) NULLs one column, keeps the row, then DELETEs it", async () => {
    const u = await seedUser();
    await caller(u).setAnthropic({ apiKey: "sk-ant-api-key" });
    await caller(u).setAnthropicOauth({ oauthToken: OAUTH_TOKEN });

    // Removing the api_key while the OAuth token remains keeps the row: only the
    // apiKey column is nulled.
    await caller(u).deleteAnthropic({ kind: "api_key" });
    const [afterFirst] = await db
      .select()
      .from(userAnthropicCredentials)
      .where(eq(userAnthropicCredentials.userId, u.id));
    expect(afterFirst).toBeTruthy();
    expect(afterFirst!.apiKey).toBeNull();
    expect(afterFirst!.oauthToken).toBe(OAUTH_TOKEN);

    // Removing the remaining kind (the other column is already null) DELETEs the
    // whole row rather than leaving an all-null husk.
    await caller(u).deleteAnthropic({ kind: "oauth_token" });
    const remaining = await db
      .select()
      .from(userAnthropicCredentials)
      .where(eq(userAnthropicCredentials.userId, u.id));
    expect(remaining).toHaveLength(0);
  });

  it("setCompute/deleteCompute are pure DB writes", async () => {
    const u = await seedUser();

    // A valid CPU/memory pair upserts a row.
    await caller(u).setCompute({ cpu: "2", memory: "4Gi" });
    const [row] = await db
      .select()
      .from(userCompute)
      .where(eq(userCompute.userId, u.id));
    expect(row).toBeTruthy();
    expect(row!.cpu).not.toBeNull();
    expect(row!.memory).not.toBeNull();

    // Both fields blank clears the row entirely (the setter's delete branch).
    await caller(u).setCompute({ cpu: "", memory: "" });
    expect(
      await db.select().from(userCompute).where(eq(userCompute.userId, u.id)),
    ).toHaveLength(0);

    // And the explicit delete is a no-op-safe DELETE.
    await caller(u).setCompute({ cpu: "1", memory: "2Gi" });
    await caller(u).deleteCompute();
    expect(
      await db.select().from(userCompute).where(eq(userCompute.userId, u.id)),
    ).toHaveLength(0);
  });

  it("deleting the user cascades every user_* credential row", async () => {
    const u = await seedUser();
    // Spread credentials across every user-scoped table (some via the router
    // with its validator stubbed, the rest inserted directly to avoid stubbing
    // each provider's validator — the cascade is a DB-level guarantee).
    await caller(u).setAnthropic({ apiKey: "sk-ant-api-key" });
    await caller(u).setOpenai({ apiKey: "sk-openai" });
    await caller(u).setCompute({ cpu: "1", memory: "1Gi" });
    await db
      .insert(userGeminiCredentials)
      .values({ userId: u.id, apiKey: "{}" });
    await db.insert(userAwsCredentials).values({
      userId: u.id,
      accessKeyId: "AKIAEXAMPLE0000000000",
      secretAccessKey: "secret",
    });
    await db
      .insert(userKubeconfig)
      .values({ userId: u.id, kubeconfig: "apiVersion: v1" });

    const { user: userTable } = await import("~/server/db/schema");
    await db.delete(userTable).where(eq(userTable.id, u.id));

    for (const table of [
      userAnthropicCredentials,
      userOpenaiCredentials,
      userGeminiCredentials,
      userAwsCredentials,
      userCompute,
      userKubeconfig,
    ]) {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.userId, u.id));
      expect(rows).toHaveLength(0);
    }
  });
});
