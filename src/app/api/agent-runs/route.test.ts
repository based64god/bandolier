import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestToken } from "~/lib/ingest";

// Mock the I/O boundaries the route composes — artifact store resolution +
// upload/download, the repo config + bot token reads that gate auto-merge, the
// auto-merge call itself, and push delivery — so the GET/POST handlers can be
// driven hermetically against NextRequest with no database, S3, GitHub, or web
// push. The factories defer to top-level vi.fn()s through arrows to dodge
// hoisting TDZ. The db handle is a hand-rolled fluent stub whose terminal
// calls (limit / where) resolve to whatever a test queues.

const SECRET = "test-secret"; // matches vitest.config.ts BETTER_AUTH_SECRET

const resolveArtifactStore = vi.fn<() => Promise<unknown>>();
const putArtifact = vi.fn<() => Promise<void>>();
const getArtifact = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/artifacts", () => ({
  resolveArtifactStore: () => resolveArtifactStore(),
  putArtifact: () => putArtifact(),
  getArtifact: () => getArtifact(),
  transcriptKey: (jobName: string) => `transcripts/${jobName}.txt`,
}));

const getRepoWebhookConfig = vi.fn<() => Promise<unknown>>();
vi.mock("~/server/agents/webhook-config", () => ({
  getRepoWebhookConfig: () => getRepoWebhookConfig(),
}));

const getRepoBotToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-app", () => ({
  getRepoBotToken: () => getRepoBotToken(),
}));

const enablePullRequestAutoMerge =
  vi.fn<
    (
      token: string,
      repo: string,
      pr: number,
    ) => Promise<{ ok: boolean; error?: string }>
  >();
vi.mock("~/server/agents/github-issues", () => ({
  enablePullRequestAutoMerge: (token: string, repo: string, pr: number) =>
    enablePullRequestAutoMerge(token, repo, pr),
}));

const sendPushToUser =
  vi.fn<(userId: string, payload: unknown) => Promise<void>>();
vi.mock("~/server/push", () => ({
  sendPushToUser: (userId: string, payload: unknown) =>
    sendPushToUser(userId, payload),
}));

// A fluent db stub. select({...}).from().where().limit(1) resolves to the next
// queued rows array (GET issues two selects — run row, then parent row — so the
// queue is FIFO). update(...).set(...).where(...) records its .set() payload and
// resolves; the route awaits it but ignores the value.
const selectRows: unknown[][] = [];
const updateSets: unknown[] = [];
vi.mock("~/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows.shift() ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        updateSets.push(payload);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  },
}));

const { GET, POST } = await import("~/app/api/agent-runs/route");

function authHeaders(jobName: string): Record<string, string> {
  return {
    "x-bandolier-job": jobName,
    authorization: `Bearer ${ingestToken(jobName, SECRET)}`,
  };
}

function post(
  headers: Record<string, string>,
  body = "transcript body",
): Request {
  return new Request("http://localhost/api/agent-runs", {
    method: "POST",
    headers,
    body,
  });
}

function get(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/agent-runs", { headers });
}

beforeEach(() => {
  selectRows.length = 0;
  updateSets.length = 0;
  resolveArtifactStore.mockReset().mockResolvedValue(null);
  putArtifact.mockReset().mockResolvedValue(undefined);
  getArtifact.mockReset().mockResolvedValue(null);
  getRepoWebhookConfig.mockReset().mockResolvedValue(null);
  getRepoBotToken.mockReset().mockResolvedValue(null);
  enablePullRequestAutoMerge.mockReset().mockResolvedValue({ ok: true });
  sendPushToUser.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticatedJob (via handlers)", () => {
  it("POST rejects a missing token with 401", async () => {
    const res = await POST(
      post({ "x-bandolier-job": "job-1" }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("POST rejects a missing job header with 401", async () => {
    const res = await POST(
      post({ authorization: "Bearer whatever" }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("POST rejects a token minted for a different job with 401", async () => {
    const res = await POST(
      post({
        "x-bandolier-job": "job-1",
        authorization: `Bearer ${ingestToken("job-2", SECRET)}`,
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("GET rejects a bad token with 401", async () => {
    const res = await GET(
      get({ "x-bandolier-job": "job-1", authorization: "Bearer nope" }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("GET rejects a missing token with 401", async () => {
    const res = await GET(get({ "x-bandolier-job": "job-1" }) as never);
    expect(res.status).toBe(401);
  });
});

describe("POST ingest — output persistence resilience", () => {
  it("persists the run output even when putArtifact throws, leaving transcriptKey unset", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: "Fix bug" },
    ]);
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });
    putArtifact.mockRejectedValue(new Error("s3 down"));

    const res = await POST(
      post(
        {
          ...authHeaders("job-1"),
          "x-bandolier-pr-url": "https://github.com/acme/app/pull/7",
          "x-bandolier-tokens": JSON.stringify({
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          }),
        },
        "the transcript",
      ) as never,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(putArtifact).toHaveBeenCalledOnce();
    // The run row is still updated with the output; transcriptKey is absent
    // because the upload failed.
    expect(updateSets).toHaveLength(1);
    const set = updateSets[0] as Record<string, unknown>;
    expect(set.pullRequestUrl).toBe("https://github.com/acme/app/pull/7");
    expect(set.inputTokens).toBe(10);
    expect(set.outputTokens).toBe(20);
    expect(set.cacheReadInputTokens).toBe(3);
    expect(set.cacheCreationInputTokens).toBe(4);
    expect(set).not.toHaveProperty("transcriptKey");
  });

  it("records transcriptKey when the upload succeeds", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });

    const res = await POST(post(authHeaders("job-9")) as never);

    expect(res.status).toBe(200);
    expect(putArtifact).toHaveBeenCalledOnce();
    const set = updateSets[0] as Record<string, unknown>;
    expect(set.transcriptKey).toBe("transcripts/job-9.txt");
  });

  it("skips upload entirely when no artifact store is configured", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    resolveArtifactStore.mockResolvedValue(null);

    const res = await POST(post(authHeaders("job-2")) as never);

    expect(res.status).toBe(200);
    expect(putArtifact).not.toHaveBeenCalled();
    expect(updateSets[0]).not.toHaveProperty("transcriptKey");
  });
});

describe("POST ingest — auto-merge gate", () => {
  it("enables auto-merge with the parsed PR number when the repo opted in", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    getRepoWebhookConfig.mockResolvedValue({ autoMergeBandolierPrs: true });
    getRepoBotToken.mockResolvedValue("bot-token");

    await POST(
      post({
        ...authHeaders("job-3"),
        "x-bandolier-pr-url": "https://github.com/acme/app/pull/42",
      }) as never,
    );

    expect(enablePullRequestAutoMerge).toHaveBeenCalledWith(
      "bot-token",
      "acme/app",
      42,
    );
  });

  it("does not enable auto-merge for an opted-out repo", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    getRepoWebhookConfig.mockResolvedValue({ autoMergeBandolierPrs: false });

    await POST(
      post({
        ...authHeaders("job-4"),
        "x-bandolier-pr-url": "https://github.com/acme/app/pull/42",
      }) as never,
    );

    expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
  });

  it("does not enable auto-merge when the PR url has no /pull/<n> segment", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    getRepoWebhookConfig.mockResolvedValue({ autoMergeBandolierPrs: true });
    getRepoBotToken.mockResolvedValue("bot-token");

    await POST(
      post({
        ...authHeaders("job-5"),
        "x-bandolier-pr-url": "https://github.com/acme/app/issues/42",
      }) as never,
    );

    expect(getRepoWebhookConfig).not.toHaveBeenCalled();
    expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
  });

  it("does not enable auto-merge when no bot token is available", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);
    getRepoWebhookConfig.mockResolvedValue({ autoMergeBandolierPrs: true });
    getRepoBotToken.mockResolvedValue(null);

    await POST(
      post({
        ...authHeaders("job-6"),
        "x-bandolier-pr-url": "https://github.com/acme/app/pull/1",
      }) as never,
    );

    expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
  });
});

describe("POST ingest — push notification", () => {
  it("sends a push to the spawning user with a neutral title on success", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: "u1", displayName: "My run" },
    ]);

    await POST(post(authHeaders("job-7")) as never);

    expect(sendPushToUser).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        title: "Agent finished",
        body: "My run",
        tag: "complete:job-7",
        url: "/repo/acme/app",
      }),
    );
  });

  it("uses the failed title when the harness reports a Failed status", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: "u1", displayName: "My run" },
    ]);

    await POST(
      post({
        ...authHeaders("job-8"),
        "x-bandolier-status": "Failed",
      }) as never,
    );

    expect(sendPushToUser).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ title: "Agent failed" }),
    );
  });

  it("does not push when the run has no spawnedBy", async () => {
    selectRows.push([
      { repoFullName: "acme/app", spawnedBy: null, displayName: null },
    ]);

    await POST(post(authHeaders("job-10")) as never);

    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

describe("GET parent transcript", () => {
  it("404s when the run has no parent", async () => {
    selectRows.push([{ parentJobName: null }]);

    const res = await GET(get(authHeaders("job-a")) as never);

    expect(res.status).toBe(404);
  });

  it("404s when the run row is missing entirely", async () => {
    selectRows.push([]);

    const res = await GET(get(authHeaders("job-a")) as never);

    expect(res.status).toBe(404);
  });

  it("404s when the parent has no transcriptKey", async () => {
    selectRows.push([{ parentJobName: "parent-job" }]);
    selectRows.push([{ transcriptKey: null, repoFullName: "acme/app" }]);

    const res = await GET(get(authHeaders("job-b")) as never);

    expect(res.status).toBe(404);
  });

  it("404s when the artifact object is missing", async () => {
    selectRows.push([{ parentJobName: "parent-job" }]);
    selectRows.push([
      { transcriptKey: "transcripts/parent.txt", repoFullName: "acme/app" },
    ]);
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });
    getArtifact.mockResolvedValue(null);

    const res = await GET(get(authHeaders("job-c")) as never);

    expect(res.status).toBe(404);
  });

  it("serves the parent transcript body when present", async () => {
    selectRows.push([{ parentJobName: "parent-job" }]);
    selectRows.push([
      { transcriptKey: "transcripts/parent.txt", repoFullName: "acme/app" },
    ]);
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });
    getArtifact.mockResolvedValue("parent transcript contents");

    const res = await GET(get(authHeaders("job-d")) as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    await expect(res.text()).resolves.toBe("parent transcript contents");
  });
});
