import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GithubReposModule from "~/server/agents/github-repos";
import type * as GithubTokenModule from "~/server/agents/github-token";

// The webhooks router's repo-config setters against a REAL Postgres: every
// setter is a *partial* upsert (INSERT … ON CONFLICT DO UPDATE) that must touch
// ONLY its own columns, so three different setters targeting the same repo row
// build it up field by field without clobbering each other. Only the admin gate
// (getUserGithubToken + isRepoAdmin, which reach GitHub) is stubbed; the
// upserts, the configuredBy FK stamp, and the ON CONFLICT merge run for real.
const getUserGithubToken = vi
  .fn<() => Promise<string | null>>()
  .mockResolvedValue("gh-token");
vi.mock("~/server/agents/github-token", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubTokenModule>()),
  getUserGithubToken: () => getUserGithubToken(),
}));

const isRepoAdmin = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
vi.mock("~/server/agents/github-repos", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubReposModule>()),
  isRepoAdmin: () => isRepoAdmin(),
}));

const { webhooksRouter } = await import("~/server/api/routers/webhooks");
const { createCallerFactory } = await import("~/server/api/trpc");
const { repoWebhookConfig } = await import("~/server/db/schema");
const { db, resetDb, testCtx } = await import("~/test/integration/harness");
const { seedUser } = await import("~/test/integration/seed");

const createCaller = createCallerFactory(webhooksRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

const REPO = "acme/widgets";

async function readConfig() {
  const [row] = await db
    .select()
    .from(repoWebhookConfig)
    .where(eq(repoWebhookConfig.repoFullName, REPO));
  return row;
}

describe("webhooks repo-config partial upsert (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    getUserGithubToken.mockClear().mockResolvedValue("gh-token");
    isRepoAdmin.mockClear().mockResolvedValue(true);
  });

  it("setConfig, setDefaultModel, setDefaultEffort each touch only their own columns", async () => {
    // configuredBy is an FK to user, so the caller must be a real row.
    const u = await seedUser();

    // 1) setConfig writes prefix + agentImage + systemPrompt, nothing else.
    await caller(u).setConfig({
      repoFullName: REPO,
      prefix: "/bando",
      agentImage: "ghcr.io/acme/harness:1",
      systemPrompt: "Follow the style guide.",
    });
    let row = await readConfig();
    expect(row!.prefix).toBe("/bando");
    expect(row!.agentImage).toBe("ghcr.io/acme/harness:1");
    expect(row!.systemPrompt).toBe("Follow the style guide.");
    expect(row!.configuredBy).toBe(u.id);
    // The model/effort columns this setter doesn't own are still their defaults.
    expect(row!.defaultWebhookModel).toBeNull();
    expect(row!.defaultWebhookEffort).toBeNull();

    // 2) setDefaultModel sets ONLY defaultWebhookModel — the setConfig columns
    //    must survive the ON CONFLICT DO UPDATE.
    await caller(u).setDefaultModel({
      repoFullName: REPO,
      model: "claude-sonnet-4-5",
    });
    row = await readConfig();
    expect(row!.defaultWebhookModel).toBe("claude-sonnet-4-5");
    expect(row!.prefix).toBe("/bando");
    expect(row!.agentImage).toBe("ghcr.io/acme/harness:1");
    expect(row!.systemPrompt).toBe("Follow the style guide.");
    expect(row!.defaultWebhookEffort).toBeNull();

    // 3) setDefaultEffort sets ONLY defaultWebhookEffort — every earlier column
    //    stays put.
    await caller(u).setDefaultEffort({ repoFullName: REPO, effort: "high" });
    row = await readConfig();
    expect(row!.defaultWebhookEffort).toBe("high");
    expect(row!.defaultWebhookModel).toBe("claude-sonnet-4-5");
    expect(row!.prefix).toBe("/bando");
    expect(row!.agentImage).toBe("ghcr.io/acme/harness:1");
    expect(row!.systemPrompt).toBe("Follow the style guide.");

    // Three setters, still exactly one row — every write hit the same PK.
    expect(
      await db
        .select()
        .from(repoWebhookConfig)
        .where(eq(repoWebhookConfig.repoFullName, REPO)),
    ).toHaveLength(1);
  });

  it("blank values clear only their own column (partial upsert, not a wipe)", async () => {
    const u = await seedUser();
    await caller(u).setConfig({ repoFullName: REPO, prefix: "/bando" });
    await caller(u).setDefaultModel({
      repoFullName: REPO,
      model: "claude-sonnet-4-5",
    });

    // A blank model clears defaultWebhookModel (→ null) but must leave prefix.
    await caller(u).setDefaultModel({ repoFullName: REPO, model: "" });
    const row = await readConfig();
    expect(row!.defaultWebhookModel).toBeNull();
    expect(row!.prefix).toBe("/bando");
  });

  it("rejects a non-admin before any row is written", async () => {
    const u = await seedUser();
    isRepoAdmin.mockResolvedValue(false);
    await expect(
      caller(u).setDefaultModel({ repoFullName: REPO, model: "m" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readConfig()).toBeUndefined();
  });
});
