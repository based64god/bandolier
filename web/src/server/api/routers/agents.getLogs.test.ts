import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Router-level authorization tests for the persisted-transcript / ACP-frame
// fallbacks that only run once the live pod is gone. The authz primitives have
// their own unit tests; here we exercise the wiring in agents.getLogs /
// agents.acpPull that decides whether a caller may read a *persisted* run.
//
// The I/O collaborators along those paths (k8s list/log, artifact store,
// ownership check) are stubbed so a decision can be provoked without a
// database, Kubernetes, or S3. Factories defer to top-level vi.fn()s through
// arrows to dodge hoisting TDZ.
const assertRepoAccess = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const requireKubeconfig = vi
  .fn<() => Promise<string>>()
  .mockResolvedValue("kubeconfig");
const assertOwnsInteractiveJob = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("~/server/agents/authz", () => ({
  assertRepoAccess: (...a: unknown[]) => assertRepoAccess(...(a as [])),
  requireKubeconfig: (...a: unknown[]) => requireKubeconfig(...(a as [])),
  assertOwnsInteractiveJob: (...a: unknown[]) =>
    assertOwnsInteractiveJob(...(a as [])),
  // The selector strings are inputs to the (mocked) k8s list; their exact
  // value is irrelevant to these tests.
  repoViewSelector: () => "view-selector",
  ownedSelector: () => "owned-selector",
}));

const resolveArtifactStore = vi.fn<() => Promise<unknown>>();
const getArtifact = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/artifacts", () => ({
  resolveArtifactStore: (...a: unknown[]) => resolveArtifactStore(...(a as [])),
  getArtifact: (...a: unknown[]) => getArtifact(...(a as [])),
}));

const listNamespacedPod = vi.fn<() => Promise<{ items: unknown[] }>>();
const readNamespacedPodLog = vi.fn<() => Promise<string>>();
vi.mock("~/server/k8s/client", () => ({
  getCoreV1Api: () => ({
    listNamespacedPod: (...a: unknown[]) => listNamespacedPod(...(a as [])),
    readNamespacedPodLog: (...a: unknown[]) =>
      readNamespacedPodLog(...(a as [])),
  }),
  getBatchV1Api: () => ({}),
}));

const { agentsRouter } = await import("~/server/api/routers/agents");
const { createCallerFactory } = await import("~/server/api/trpc");

const createCaller = createCallerFactory(agentsRouter);

// A chainable stand-in for ctx.db.select(...).from(...).where(...).limit(...).
// Every query on these paths terminates in .limit(), which resolves to the
// next queued result array (or [] when the queue is drained).
function fakeDb(results: unknown[][]) {
  const queue = [...results];
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(queue.shift() ?? []),
  };
  return chain;
}

function caller(db: unknown, userId = "u1") {
  return createCaller({
    db,
    headers: new Headers(),
    session: {
      session: {
        id: "s1",
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      user: { id: userId, name: "Ada", email: "ada@x.com" },
    },
  } as never);
}

beforeEach(() => {
  assertRepoAccess.mockReset().mockResolvedValue(undefined);
  requireKubeconfig.mockReset().mockResolvedValue("kubeconfig");
  assertOwnsInteractiveJob.mockReset().mockResolvedValue(undefined);
  resolveArtifactStore.mockReset();
  getArtifact.mockReset();
  listNamespacedPod.mockReset();
  readNamespacedPodLog.mockReset();
});

describe("agents.getLogs persisted-transcript fallback", () => {
  it("returns NOT_FOUND without fetching a transcript when the run belongs to another tenant", async () => {
    // Pod is gone (empty list) and the guessed jobName maps to another user's
    // run in a different repo — neither ownership nor repo match, so the
    // fallback must refuse before touching the artifact store.
    listNamespacedPod.mockResolvedValue({ items: [] });
    const db = fakeDb([
      [{ transcriptKey: "t-key", repoFullName: "other/repo", spawnedBy: "u2" }],
    ]);

    const err = await caller(db)
      .getLogs({
        podName: "pod-1",
        namespace: "ns",
        jobName: "job-1",
        repoFullName: "owner/repo",
      })
      .then(
        () => {
          throw new Error("expected getLogs to reject");
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("NOT_FOUND");
    expect(resolveArtifactStore).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("returns the persisted transcript when the run belongs to the authorized repo", async () => {
    // Pod is gone, but the run row's own repo matches the repo this query was
    // authorized for, so a collaborator may read it even though they didn't
    // spawn it.
    listNamespacedPod.mockResolvedValue({ items: [] });
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });
    getArtifact.mockResolvedValue("the transcript");
    const db = fakeDb([
      [{ transcriptKey: "t-key", repoFullName: "owner/repo", spawnedBy: "u2" }],
    ]);

    const out = await caller(db).getLogs({
      podName: "pod-1",
      namespace: "ns",
      jobName: "job-1",
      repoFullName: "owner/repo",
    });

    expect(out).toBe("the transcript");
    expect(resolveArtifactStore).toHaveBeenCalledWith(db, "owner/repo");
    expect(getArtifact).toHaveBeenCalledWith({ bucket: "b" }, "t-key");
    expect(readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it("still reaches the transcript fallback when the k8s pod list throws", async () => {
    // A transient list/log failure must not mask the persisted transcript: the
    // catch {} swallows it and the owner-scoped fallback still resolves.
    listNamespacedPod.mockRejectedValue(new Error("k8s unreachable"));
    resolveArtifactStore.mockResolvedValue({ bucket: "b" });
    getArtifact.mockResolvedValue("recovered transcript");
    const db = fakeDb([
      [{ transcriptKey: "t-key", repoFullName: "owner/repo", spawnedBy: "u1" }],
    ]);

    const out = await caller(db).getLogs({
      podName: "pod-1",
      namespace: "ns",
      jobName: "job-1",
      repoFullName: "owner/repo",
    });

    expect(out).toBe("recovered transcript");
    expect(getArtifact).toHaveBeenCalledWith({ bucket: "b" }, "t-key");
  });
});

describe("agents.getLogs live pod read", () => {
  it("returns the running pod's live log, naming the harness container", async () => {
    // The pod is present (in-progress run), so its live log is authoritative and
    // the transcript fallback must not be consulted.
    listNamespacedPod.mockResolvedValue({
      items: [{ metadata: { name: "pod-1" } }],
    });
    readNamespacedPodLog.mockResolvedValue("live tail\n");

    const out = await caller(fakeDb([])).getLogs({
      podName: "pod-1",
      namespace: "ns",
      jobName: "job-1",
      repoFullName: "owner/repo",
      tailLines: 100,
    });

    expect(out).toBe("live tail\n");
    // A sidecar can make the pod multi-container, so the container is named.
    expect(readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pod-1", container: "harness" }),
    );
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("returns an empty log — not NOT_FOUND — when a visible pod's read fails", async () => {
    // A just-launched pod whose container is still starting (or a transient read
    // hiccup) must surface as "No logs yet.", recoverable on the next poll —
    // never masked as the finished-run fallback's "Logs not found", which a
    // running pod (no transcript yet) would otherwise hit.
    listNamespacedPod.mockResolvedValue({
      items: [{ metadata: { name: "pod-1" } }],
    });
    readNamespacedPodLog.mockRejectedValue(
      new Error("container harness in pod pod-1 is waiting to start"),
    );

    const out = await caller(fakeDb([])).getLogs({
      podName: "pod-1",
      namespace: "ns",
      jobName: "job-1",
      repoFullName: "owner/repo",
      tailLines: 100,
    });

    expect(out).toBe("");
    // The pod is present, so the finished-run transcript is never consulted.
    expect(resolveArtifactStore).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
  });
});

describe("agents.acpPull run-row-missing fallback", () => {
  it("falls back to assertOwnsInteractiveJob and rejects a non-owner when the run row is gone", async () => {
    // No run row (pruned or predating spawnedBy) → the live-pod ownership check
    // decides. It finds no owned pod and throws NOT_FOUND, which must
    // propagate rather than the frame query running.
    assertOwnsInteractiveJob.mockRejectedValue(
      new TRPCError({
        code: "NOT_FOUND",
        message: "Interactive agent job-1 not found.",
      }),
    );
    const db = fakeDb([[]]);

    const err = await caller(db)
      .acpPull({
        namespace: "ns",
        jobName: "job-1",
        repoFullName: "owner/repo",
      })
      .then(
        () => {
          throw new Error("expected acpPull to reject");
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("NOT_FOUND");
    expect(assertOwnsInteractiveJob).toHaveBeenCalledWith(
      db,
      "u1",
      "ns",
      "job-1",
      "owner/repo",
    );
  });
});
