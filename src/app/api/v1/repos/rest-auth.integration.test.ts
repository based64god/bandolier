import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GithubApiModule from "~/server/agents/github-api";

// The public REST surface (/api/v1/repos/{owner}/{repo}/tasks) authenticated
// against REAL api_key rows — the route file has no tests today. Only the
// GitHub repo-access probe is stubbed (it's the network boundary); the token
// resolution, expiry branch, and error-status envelope run against real DB
// state, which the unit layer only simulates.
const getRepoAccess = vi.fn<
  () => Promise<{
    accessible: boolean;
    cloneUrl?: string;
    defaultBranch?: string;
  }>
>();
vi.mock("~/server/agents/github-api", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubApiModule>()),
  getRepoAccess: (...a: unknown[]) => getRepoAccess(...(a as [])),
}));

const { POST } = await import(
  "~/app/api/v1/repos/[owner]/[repo]/tasks/route"
);
const { resetDb } = await import("~/test/integration/harness");
const { seedAccount, seedApiKey, seedUser } = await import(
  "~/test/integration/seed"
);

function tasksPost(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/v1/repos/o/r/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ task: "do it", model: "claude-sonnet-4-5" }),
  });
}

const params = { params: Promise.resolve({ owner: "o", repo: "r" }) };

describe("REST /v1 tasks auth matrix (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    getRepoAccess.mockReset();
  });

  it("401s with no credentials", async () => {
    const res = await POST(tasksPost({}), params);
    expect(res.status).toBe(401);
  });

  it("401s on an unknown or malformed bearer token", async () => {
    const res = await POST(
      tasksPost({ authorization: "Bearer bnd_not-a-real-key" }),
      params,
    );
    expect(res.status).toBe(401);
  });

  it("401s on an expired key — the real expiry branch against a past timestamp", async () => {
    const u = await seedUser();
    const expired = await seedApiKey(u.id, {
      name: "expired",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await POST(
      tasksPost({ authorization: `Bearer ${expired.token}` }),
      params,
    );
    expect(res.status).toBe(401);
    // getRepoAccess is never reached when auth fails.
    expect(getRepoAccess).not.toHaveBeenCalled();
  });

  it("403s a valid key whose user cannot reach the repo", async () => {
    const u = await seedUser();
    await seedAccount(u.id, { accessToken: "gho_valid" });
    const key = await seedApiKey(u.id, { name: "live" });
    getRepoAccess.mockResolvedValue({ accessible: false });

    const res = await POST(
      tasksPost({ authorization: `Bearer ${key.token}` }),
      params,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found or not accessible/i);
  });

  it("accepts the key via x-api-key too (same 403 path once authenticated)", async () => {
    const u = await seedUser();
    await seedAccount(u.id, { accessToken: "gho_valid" });
    const key = await seedApiKey(u.id, { name: "live2" });
    getRepoAccess.mockResolvedValue({ accessible: false });

    const res = await POST(tasksPost({ "x-api-key": key.token }), params);
    // Authenticated (not 401) → reached the access check → 403.
    expect(res.status).toBe(403);
    expect(getRepoAccess).toHaveBeenCalledTimes(1);
  });
});
