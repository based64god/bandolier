import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPAWNED_BY_LABEL, spawnedByLabelValue } from "~/server/agents/labels";
import { repoToNamespace } from "~/server/agents/namespace";

// The tenant-isolation boundary depends only on the caller's own GitHub token
// reaching the repo; mock the two collaborators that answer that so the tests
// exercise the caching/authorization logic without a database or GitHub.
const getUserGithubToken = vi
  .fn<() => Promise<string | null>>()
  .mockResolvedValue("gh-tok");
vi.mock("~/server/agents/github-token", () => ({
  getUserGithubToken: () => getUserGithubToken(),
}));

const userHasRepoAccess = vi
  .fn<() => Promise<boolean>>()
  .mockResolvedValue(true);
vi.mock("~/server/agents/github-repos", () => ({
  userHasRepoAccess: () => userHasRepoAccess(),
}));

const { assertRepoAccess, repoViewSelector } =
  await import("~/server/agents/authz");

const LABEL_SELECTOR = "app=bandolier-agent";

beforeEach(() => {
  getUserGithubToken.mockReset().mockResolvedValue("gh-tok");
  userHasRepoAccess.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("repoViewSelector", () => {
  const userId = "u1";

  it("drops spawned-by scoping when the query targets the repo's own namespace", () => {
    const repo = "owner/repo";
    const selector = repoViewSelector(userId, repoToNamespace(repo), repo);
    // A repo view lists every collaborator's tasks — only the base label.
    expect(selector).toBe(LABEL_SELECTOR);
    expect(selector).not.toContain(SPAWNED_BY_LABEL);
  });

  it("appends `extra` to the repo-scoped selector without owner scoping", () => {
    const repo = "owner/repo";
    const selector = repoViewSelector(
      userId,
      repoToNamespace(repo),
      repo,
      "bandolier.io/job=j1",
    );
    expect(selector).toBe(`${LABEL_SELECTOR},bandolier.io/job=j1`);
    expect(selector).not.toContain(SPAWNED_BY_LABEL);
  });

  it("falls back to owner scoping when no repo is given", () => {
    const selector = repoViewSelector(userId, "some-namespace");
    expect(selector).toBe(
      `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)}`,
    );
  });

  it("falls back to owner scoping when the namespace is not the repo's own", () => {
    // Naming an accessible repo can't unlock another namespace: a mismatched
    // namespace/repo pair stays owner-scoped.
    const selector = repoViewSelector(userId, "unrelated-ns", "owner/repo");
    expect(selector).toBe(
      `${LABEL_SELECTOR},${SPAWNED_BY_LABEL}=${spawnedByLabelValue(userId)}`,
    );
    expect(selector).toContain(SPAWNED_BY_LABEL);
  });
});

describe("assertRepoAccess", () => {
  const db = {} as never;

  it("is a no-op for repo-less operations (no token lookup)", async () => {
    await expect(
      assertRepoAccess(db, "u1", undefined),
    ).resolves.toBeUndefined();
    expect(getUserGithubToken).not.toHaveBeenCalled();
  });

  it("resolves when the caller's token can reach the repo", async () => {
    await expect(
      assertRepoAccess(db, "u1", "owner/repo"),
    ).resolves.toBeUndefined();
    expect(userHasRepoAccess).toHaveBeenCalled();
  });

  it("throws FORBIDDEN when the caller has no linked GitHub token", async () => {
    getUserGithubToken.mockResolvedValue(null);
    const err = await assertRepoAccess(db, "u-no-token", "owner/repo").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    // A missing token must not even consult the repo-access check.
    expect(userHasRepoAccess).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when the caller cannot reach the repo", async () => {
    userHasRepoAccess.mockResolvedValue(false);
    const err = await assertRepoAccess(db, "u2", "owner/private").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("FORBIDDEN");
    expect((err as TRPCError).message).toContain("owner/private");
  });

  it("caches a positive result so a repeat check skips the GitHub API", async () => {
    await assertRepoAccess(db, "u3", "owner/cached");
    await assertRepoAccess(db, "u3", "owner/cached");
    // The second call is served from the short-TTL cache.
    expect(userHasRepoAccess).toHaveBeenCalledTimes(1);
  });

  it("does not cache a denial — a non-member's probes re-verify every time", async () => {
    userHasRepoAccess.mockResolvedValue(false);
    await assertRepoAccess(db, "u4", "owner/denied").catch(() => undefined);
    await assertRepoAccess(db, "u4", "owner/denied").catch(() => undefined);
    expect(userHasRepoAccess).toHaveBeenCalledTimes(2);
  });

  it("re-verifies access once the cache TTL has elapsed", async () => {
    vi.useFakeTimers();
    await assertRepoAccess(db, "u5", "owner/ttl");
    // Advance past REPO_ACCESS_TTL_MS (60s).
    vi.advanceTimersByTime(61_000);
    await assertRepoAccess(db, "u5", "owner/ttl");
    expect(userHasRepoAccess).toHaveBeenCalledTimes(2);
  });
});
