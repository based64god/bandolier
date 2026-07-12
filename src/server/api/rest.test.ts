import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the I/O boundaries rest.ts composes — API-key lookup, better-auth
// session resolution, the db user query, tRPC caller construction, and the
// user's GitHub token — so authenticate/callerForUser/getAccessibleRepo can be
// driven hermetically. The pure helpers below (statusForTrpcError et al.) don't
// touch any of these, so their tests are unaffected. The factories defer to
// top-level vi.fn()s through arrows to dodge hoisting TDZ.
const resolveApiKey =
  vi.fn<
    (database: unknown, token: string) => Promise<{ userId: string } | null>
  >();
vi.mock("~/server/agents/api-keys", () => ({
  resolveApiKey: (...args: [unknown, string]) => resolveApiKey(...args),
}));

const getUserGithubToken =
  vi.fn<(database: unknown, userId: string) => Promise<string | null>>();
vi.mock("~/server/agents/github-token", () => ({
  getUserGithubToken: (...args: [unknown, string]) =>
    getUserGithubToken(...args),
}));

const getSession =
  vi.fn<
    (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>
  >();
vi.mock("~/server/better-auth", () => ({
  auth: {
    api: {
      getSession: (input: { headers: Headers }) => getSession(input),
    },
  },
}));

// callerForUser only uses the fluent select({...}).from().where().limit(1)
// chain; the terminal limit() resolves to whatever rows a test queues up.
const dbUserRows = vi.fn<() => Promise<unknown[]>>();
vi.mock("~/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => dbUserRows(),
        }),
      }),
    }),
  },
}));

const createCaller = vi.fn<(ctx: unknown) => unknown>();
vi.mock("~/server/api/root", () => ({
  createCaller: (ctx: unknown) => createCaller(ctx),
}));

import { type NextRequest, NextResponse } from "next/server";

import {
  authenticate,
  callerForUser,
  errorMessage,
  getAccessibleRepo,
  resolve,
  restHandler,
  statusForTrpcError,
  toTaskResource,
} from "~/server/api/rest";
// The mocked instance, so tests can assert it is what gets forwarded.
import { db } from "~/server/db";

beforeEach(() => {
  resolveApiKey.mockReset().mockResolvedValue(null);
  getUserGithubToken.mockReset().mockResolvedValue(null);
  getSession.mockReset().mockResolvedValue(null);
  dbUserRows.mockReset().mockResolvedValue([]);
  createCaller.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/tasks", { headers });
}

describe("authenticate", () => {
  it("resolves a Bearer API key to its user without consulting the session", async () => {
    resolveApiKey.mockResolvedValue({ userId: "u1" });

    const userId = await authenticate(
      request({ authorization: "Bearer sk-live-abc" }),
    );

    expect(userId).toBe("u1");
    // The prefix is stripped before the token reaches the key store, and the
    // shared db handle is forwarded alongside it.
    expect(resolveApiKey).toHaveBeenCalledWith(db, "sk-live-abc");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("strips the Bearer prefix case-insensitively and trims the token", async () => {
    resolveApiKey.mockResolvedValue({ userId: "u1" });

    await authenticate(request({ authorization: "bearer  tok-x " }));

    expect(resolveApiKey).toHaveBeenCalledWith(db, "tok-x");
  });

  it("accepts the x-api-key header when no authorization header is set", async () => {
    resolveApiKey.mockResolvedValue({ userId: "u1" });

    const userId = await authenticate(request({ "x-api-key": " tok-y " }));

    expect(userId).toBe("u1");
    expect(resolveApiKey).toHaveBeenCalledWith(db, "tok-y");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("prefers the authorization header over x-api-key when both are present", async () => {
    resolveApiKey.mockResolvedValue({ userId: "u1" });

    await authenticate(
      request({ authorization: "Bearer tok-a", "x-api-key": "tok-b" }),
    );

    expect(resolveApiKey).toHaveBeenCalledWith(db, "tok-a");
  });

  it("returns null for an unknown API key without falling back to the session", async () => {
    resolveApiKey.mockResolvedValue(null);
    // A live session must NOT rescue a bad token — presenting a key means the
    // request is judged on that key alone.
    getSession.mockResolvedValue({ user: { id: "u-session" } });

    expect(await authenticate(request({ authorization: "Bearer bad" }))).toBe(
      null,
    );
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falls back to the session cookie when no token is presented", async () => {
    getSession.mockResolvedValue({ user: { id: "u2" } });

    const userId = await authenticate(request({ cookie: "session=abc" }));

    expect(userId).toBe("u2");
    expect(resolveApiKey).not.toHaveBeenCalled();
    // The request's own headers (carrying the cookie) reach better-auth.
    expect(getSession.mock.calls[0]![0].headers.get("cookie")).toBe(
      "session=abc",
    );
  });

  it("returns null when neither a token nor a session is present", async () => {
    getSession.mockResolvedValue(null);
    expect(await authenticate(request({}))).toBeNull();
  });

  it("treats a bare 'Bearer' header as the literal token 'Bearer'", async () => {
    // Headers normalization strips trailing whitespace, so "Bearer   " arrives
    // as "Bearer" — which the /^Bearer\s+/ strip does not match. The whole
    // value is then presented to the key store as a (bogus) token, and there is
    // no session fallback.
    getSession.mockResolvedValue({ user: { id: "u-session" } });

    expect(
      await authenticate(request({ authorization: "Bearer   " })),
    ).toBeNull();
    expect(resolveApiKey).toHaveBeenCalledWith(db, "Bearer");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falls through to the session when the stripped token is empty", async () => {
    // A raw "Bearer <only whitespace>" value can't survive real Headers
    // normalization (previous test), but the source still has this branch: the
    // stripped token is "" (falsy), so the session path runs — and notably the
    // x-api-key header is skipped too, because "" is not nullish.
    const headers = new Headers({ "x-api-key": "tok-b" });
    const raw = {
      headers: {
        get: (name: string) =>
          name === "authorization" ? "Bearer   " : headers.get(name),
      },
    } as unknown as Request;
    getSession.mockResolvedValue({ user: { id: "u3" } });

    expect(await authenticate(raw)).toBe("u3");
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledOnce();
  });
});

describe("callerForUser", () => {
  const row = { id: "u1", name: "Ada", email: "ada@x.com", image: null };

  it("returns null when the user row does not exist", async () => {
    dbUserRows.mockResolvedValue([]);

    expect(await callerForUser("u-missing")).toBeNull();
    expect(createCaller).not.toHaveBeenCalled();
  });

  it("builds a synthetic session standing in for the user", async () => {
    dbUserRows.mockResolvedValue([row]);
    const before = Date.now();

    await callerForUser("u1");

    expect(createCaller).toHaveBeenCalledOnce();
    const ctx = createCaller.mock.calls[0]![0] as {
      db: unknown;
      headers: unknown;
      session: {
        session: { id: string; userId: string; expiresAt: Date };
        user: Record<string, unknown>;
      };
    };
    expect(ctx.db).toBe(db);
    expect(ctx.headers).toBeInstanceOf(Headers);
    // The session id is namespaced so REST-born sessions are recognizable, and
    // it expires in the future so downstream checks treat it as live.
    expect(ctx.session.session.id).toBe("rest:u1");
    expect(ctx.session.session.userId).toBe("u1");
    expect(ctx.session.session.expiresAt.getTime()).toBeGreaterThan(before);
    expect(ctx.session.user).toMatchObject({
      id: "u1",
      name: "Ada",
      email: "ada@x.com",
      image: null,
      emailVerified: true,
    });
  });

  it("returns the caller that createCaller produced", async () => {
    dbUserRows.mockResolvedValue([row]);
    const sentinel = { tasks: {} };
    createCaller.mockReturnValue(sentinel);

    expect(await callerForUser("u1")).toBe(sentinel);
  });
});

describe("getAccessibleRepo", () => {
  it("returns null without touching GitHub when the user has no token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getUserGithubToken.mockResolvedValue(null);

    expect(await getAccessibleRepo("u1", "o/r")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when GitHub says the repo is not reachable", async () => {
    // 404 (and any other non-ok) collapses to null so callers answer
    // "forbidden" uniformly and task existence isn't leaked.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    getUserGithubToken.mockResolvedValue("gh-tok");

    expect(await getAccessibleRepo("u1", "o/r")).toBeNull();
  });

  it("maps an accessible repo to its clone URL and default branch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          clone_url: "https://github.com/o/r.git",
          default_branch: "main",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    getUserGithubToken.mockResolvedValue("gh-tok");

    expect(await getAccessibleRepo("u1", "o/r")).toEqual({
      cloneUrl: "https://github.com/o/r.git",
      defaultBranch: "main",
    });
    // The probe runs as the user (their token), against the pinned API shape.
    expect(getUserGithubToken).toHaveBeenCalledWith(db, "u1");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/o/r", {
      headers: {
        Authorization: "Bearer gh-tok",
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  });
});

describe("statusForTrpcError", () => {
  it.each([
    ["NOT_FOUND", 404],
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
  ] as const)("maps %s to %i", (code, status) => {
    expect(statusForTrpcError(new TRPCError({ code }))).toBe(status);
  });

  it("maps other tRPC error codes to 500", () => {
    expect(
      statusForTrpcError(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
    ).toBe(500);
  });

  it("maps non-tRPC errors to 500", () => {
    expect(statusForTrpcError(new Error("boom"))).toBe(500);
    expect(statusForTrpcError("not an error")).toBe(500);
  });
});

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns a generic message for non-Error values", () => {
    expect(errorMessage("a string")).toBe("Internal error");
    expect(errorMessage(undefined)).toBe("Internal error");
  });
});

describe("toTaskResource", () => {
  const internal = {
    name: "pod-abc",
    jobName: "job-abc",
    repoFullName: "owner/repo",
    displayName: "Fix bug",
    prompt: "do the thing",
    source: "dashboard",
    issueNumber: "12",
    issueUrl: "https://github.com/owner/repo/issues/12",
    createdBy: "octocat",
    status: "Running",
    currently: "thinking",
    expiresAt: "2026-01-01T00:00:00Z",
    pullRequestUrl: "https://github.com/owner/repo/pull/13",
  };

  it("renames jobName to id and name to podName", () => {
    const resource = toTaskResource(internal);
    expect(resource.id).toBe("job-abc");
    expect(resource.podName).toBe("pod-abc");
  });

  it("renames repoFullName to repo", () => {
    expect(toTaskResource(internal).repo).toBe("owner/repo");
  });

  it("carries through the public fields verbatim", () => {
    const resource = toTaskResource(internal);
    expect(resource).toMatchObject({
      displayName: "Fix bug",
      prompt: "do the thing",
      source: "dashboard",
      issueNumber: "12",
      issueUrl: "https://github.com/owner/repo/issues/12",
      createdBy: "octocat",
      status: "Running",
      currently: "thinking",
      pullRequestUrl: "https://github.com/owner/repo/pull/13",
      expiresAt: "2026-01-01T00:00:00Z",
    });
  });

  it("does not leak internal-only keys", () => {
    const resource = toTaskResource(internal);
    expect(resource).not.toHaveProperty("name");
    expect(resource).not.toHaveProperty("jobName");
    expect(resource).not.toHaveProperty("repoFullName");
  });

  it("reports null tokens when the run has no usage", () => {
    expect(toTaskResource(internal).tokens).toBeNull();
    expect(toTaskResource({ ...internal, tokens: null }).tokens).toBeNull();
  });

  it("exposes the token breakdown plus a computed total", () => {
    const resource = toTaskResource({
      ...internal,
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
      },
    });
    expect(resource.tokens).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      totalTokens: 165,
    });
  });
});

describe("resolve", () => {
  const userRow = { id: "u1", name: "Ada", email: "ada@x.com", image: null };

  // Casts a bare Request into the NextRequest resolve() is typed against; only
  // the header-reading surface authenticate() touches is actually exercised.
  function nextRequest(headers: Record<string, string> = {}): NextRequest {
    return request(headers) as unknown as NextRequest;
  }

  // getAccessibleRepo -> getRepoAccess does a real GET /repos fetch, so stub the
  // network the same way the getAccessibleRepo suite above does.
  function stubRepoReachable() {
    getUserGithubToken.mockResolvedValue("gh-tok");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            clone_url: "https://github.com/o/r.git",
            default_branch: "main",
          }),
      }),
    );
  }

  it("returns a 401 error response when no user is authenticated", async () => {
    // No token header and getSession resolves null (beforeEach default), so
    // authenticate() yields null and resolve short-circuits before any repo probe.
    const result = await resolve(nextRequest(), "Owner/Repo");

    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(401);
    expect((await result.error.json()) as { error: string }).toEqual({
      error: "Unauthorized",
    });
  });

  it("returns a 403 error response when the repo is not accessible", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    // Has a token but GitHub denies the repo (404 -> accessible:false -> null),
    // which resolve maps to a uniform 403 so task existence isn't leaked.
    getUserGithubToken.mockResolvedValue("gh-tok");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const result = await resolve(nextRequest(), "Owner/Repo");

    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
    expect((await result.error.json()) as { error: string }).toEqual({
      error: "Repository not found or not accessible",
    });
  });

  it("returns a 401 error response when the user row is gone despite repo access", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    stubRepoReachable();
    // Repo is reachable, but the user vanished from the db (empty rows), so
    // callerForUser returns null and resolve reports Unauthorized.
    dbUserRows.mockResolvedValue([]);

    const result = await resolve(nextRequest(), "Owner/Repo");

    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(401);
    expect((await result.error.json()) as { error: string }).toEqual({
      error: "Unauthorized",
    });
    expect(createCaller).not.toHaveBeenCalled();
  });

  it("returns the resolved context when auth, repo access, and caller all succeed", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    stubRepoReachable();
    dbUserRows.mockResolvedValue([userRow]);
    const caller = { tasks: {} };
    createCaller.mockReturnValue(caller);

    const result = await resolve(nextRequest(), "Owner/Repo");

    if ("error" in result) throw new Error("expected the resolved context");
    expect(result.userId).toBe("u1");
    expect(result.caller).toBe(caller);
    // access carries getAccessibleRepo's cloneUrl/defaultBranch through verbatim.
    expect(result.access).toEqual({
      cloneUrl: "https://github.com/o/r.git",
      defaultBranch: "main",
    });
    expect(result.fullName).toBe("Owner/Repo");
    // namespace is derived (repoToNamespace, not mocked): lowercased, slash->hyphen.
    expect(result.namespace).toBe("owner-repo");
  });
});

describe("restHandler", () => {
  it("passes a returned NextResponse through untouched", async () => {
    const passthrough = NextResponse.json({ ok: true });
    const fn = vi.fn<(id: string) => Promise<NextResponse>>();
    fn.mockResolvedValue(passthrough);

    const res = await restHandler(fn)("task-1");

    // The success response is returned as-is, not re-wrapped.
    expect(res).toBe(passthrough);
    expect(fn).toHaveBeenCalledWith("task-1");
  });

  it("wraps a thrown TRPCError as the { error } envelope with its mapped status", async () => {
    const fn = vi.fn<() => Promise<NextResponse>>();
    fn.mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND", message: "no such task" }),
    );

    const res = await restHandler(fn)();

    // NOT_FOUND -> 404 via statusForTrpcError, message surfaced via errorMessage.
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: "no such task",
    });
  });

  it("wraps a generic thrown Error as a 500 error envelope", async () => {
    const fn = vi.fn<() => Promise<NextResponse>>();
    fn.mockRejectedValue(new Error("kaboom"));

    const res = await restHandler(fn)();

    // A non-tRPC error falls through to 500 but still exposes its message.
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toEqual({
      error: "kaboom",
    });
  });
});
