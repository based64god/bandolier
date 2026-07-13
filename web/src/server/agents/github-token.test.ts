import { afterEach, describe, expect, it, vi } from "vitest";

import type { db } from "~/server/db";
import {
  getGithubAccountByGithubId,
  getGithubAccountByUserId,
  getGithubIdentity,
  getUserGithubToken,
  githubGitIdentity,
} from "~/server/agents/github-token";

function mockFetchOnce(
  body: unknown,
  ok = true,
  status = 200,
  statusText = ok ? "OK" : "Error",
) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Fakes the drizzle select().from().where().limit() chain these helpers use,
 * resolving to the given rows. Filter correctness isn't asserted (comparing
 * drizzle SQL ASTs is brittle) — these tests pin the result-shape fallbacks.
 */
function fakeDb(rows: unknown[]): typeof db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  } as unknown as typeof db;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("githubGitIdentity", () => {
  it("uses the login as the git name", () => {
    expect(githubGitIdentity(12345, "octocat").name).toBe("octocat");
  });

  it("builds the GitHub no-reply email from id and login", () => {
    expect(githubGitIdentity(12345, "octocat").email).toBe(
      "12345+octocat@users.noreply.github.com",
    );
  });

  it("accepts a string id (webhook sender ids arrive as numbers, deploy as strings)", () => {
    expect(githubGitIdentity("67890", "monalisa").email).toBe(
      "67890+monalisa@users.noreply.github.com",
    );
  });
});

describe("getGithubIdentity", () => {
  it("returns only the id and login from the user response", async () => {
    mockFetchOnce({ id: 42, login: "octocat", node_id: "extra" });
    expect(await getGithubIdentity("gho_tok")).toEqual({
      id: 42,
      login: "octocat",
    });
  });

  it("calls the /user endpoint with the token and GitHub API headers", async () => {
    const fetchMock = mockFetchOnce({ id: 1, login: "x" });
    await getGithubIdentity("gho_tok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer gho_tok",
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("throws with the status and status text when the request fails", async () => {
    mockFetchOnce({}, false, 401, "Unauthorized");
    await expect(getGithubIdentity("bad_tok")).rejects.toThrow(
      "GitHub API 401: Unauthorized",
    );
  });
});

describe("getUserGithubToken", () => {
  it("returns the stored access token", async () => {
    expect(
      await getUserGithubToken(fakeDb([{ accessToken: "gho_abc" }]), "u1"),
    ).toBe("gho_abc");
  });

  it("returns null when the user has no linked GitHub account", async () => {
    expect(await getUserGithubToken(fakeDb([]), "u1")).toBeNull();
  });

  it("returns null when the linked account has no stored token", async () => {
    expect(
      await getUserGithubToken(fakeDb([{ accessToken: null }]), "u1"),
    ).toBeNull();
  });
});

describe("getGithubAccountByGithubId", () => {
  it("returns the linked user id and token", async () => {
    expect(
      await getGithubAccountByGithubId(
        fakeDb([{ userId: "u1", accessToken: "gho_abc" }]),
        "12345",
      ),
    ).toEqual({ userId: "u1", accessToken: "gho_abc" });
  });

  it("returns null when no Bandolier user is linked to the GitHub id", async () => {
    expect(await getGithubAccountByGithubId(fakeDb([]), "12345")).toBeNull();
  });

  it("keeps the row when only the token is null (a null token must not hide the user)", async () => {
    expect(
      await getGithubAccountByGithubId(
        fakeDb([{ userId: "u1", accessToken: null }]),
        "12345",
      ),
    ).toEqual({ userId: "u1", accessToken: null });
  });
});

describe("getGithubAccountByUserId", () => {
  it("returns the linked GitHub account id and token", async () => {
    expect(
      await getGithubAccountByUserId(
        fakeDb([{ githubId: "12345", accessToken: "gho_abc" }]),
        "u1",
      ),
    ).toEqual({ githubId: "12345", accessToken: "gho_abc" });
  });

  it("returns null when the user has no linked GitHub account", async () => {
    expect(await getGithubAccountByUserId(fakeDb([]), "u1")).toBeNull();
  });
});
