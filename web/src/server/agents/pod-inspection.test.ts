import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pod-inspection derives a pod's live status from its recent logs and caches the
// in-flight read. The only I/O collaborator is the k8s core API's log read, so
// mock just that — `getCoreV1Api` returns an object whose `readNamespacedPodLog`
// defers to a controllable top-level vi.fn (arrow indirection dodges hoisting
// TDZ). The token parsing runs against the REAL ~/lib/tokens so the asserted
// TokenUsage reflects the actual marker contract, not a stub's guess.
const readNamespacedPodLog = vi.fn<() => Promise<string>>();
vi.mock("~/server/k8s/client", () => ({
  getCoreV1Api: () => ({
    readNamespacedPodLog: (...a: unknown[]) =>
      readNamespacedPodLog(...(a as [])),
  }),
}));

const { inspectPod } = await import("~/server/agents/pod-inspection");

const EMPTY_FALLBACK = {
  currently: null,
  pullRequestUrl: null,
  createdIssueUrl: null,
  awaitingInput: false,
  tokens: null,
};

// The cache is module-level and keyed by namespace/pod, so each test uses a
// unique namespace to avoid cache bleed between cases (mirrors how authz.test's
// caching cases each use a distinct repo).
beforeEach(() => {
  readNamespacedPodLog.mockReset().mockResolvedValue("");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inspectPod log derivations", () => {
  it("extracts the PR_URL and ISSUE_URL markers and tail-reads 200 lines", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "[harness] opening pull request",
        "PR_URL=https://github.com/owner/repo/pull/7",
        "ISSUE_URL=https://github.com/owner/repo/issues/12",
      ].join("\n"),
    );

    const result = await inspectPod("pod-urls", "ns-urls", "Running", "kc");

    expect(result.pullRequestUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(result.createdIssueUrl).toBe(
      "https://github.com/owner/repo/issues/12",
    );
    expect(readNamespacedPodLog).toHaveBeenCalledWith({
      name: "pod-urls",
      namespace: "ns-urls",
      tailLines: 200,
    });
  });

  it("leaves both URLs and tokens null when no markers are present", async () => {
    readNamespacedPodLog.mockResolvedValue("just some plain work output\n");

    const result = await inspectPod(
      "pod-no-markers",
      "ns-no-markers",
      "Running",
      "kc",
    );

    expect(result.pullRequestUrl).toBeNull();
    expect(result.createdIssueUrl).toBeNull();
    expect(result.tokens).toBeNull();
  });

  it("parses token usage from the harness token marker", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "working",
        // On its own line, as the Go harness emits it. Prefixing with [harness]
        // is fine: the parser scans from the marker to the next newline.
        '[harness] BANDOLIER_TOKENS={"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":5000,"cache_creation_input_tokens":800}',
      ].join("\n"),
    );

    const result = await inspectPod("pod-tok", "ns-tok", "Running", "kc");

    expect(result.tokens).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 800,
    });
  });

  it("reports the last non-harness, non-user line as what Claude is doing now", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "Reading the codebase",
        "[user] please fix the failing test",
        "Analyzing the failure",
        "[harness] BANDOLIER_AWAIT_INPUT",
        "", // trailing blank from the final newline — must be skipped
      ].join("\n"),
    );

    const result = await inspectPod(
      "pod-currently",
      "ns-currently",
      "Running",
      "kc",
    );

    expect(result.currently).toBe("Analyzing the failure");
  });

  it("leaves currently null when every recent line is harness or user chatter", async () => {
    readNamespacedPodLog.mockResolvedValue(
      ["[harness] booting", "[user] hello", ""].join("\n"),
    );

    const result = await inspectPod("pod-nocurr", "ns-nocurr", "Running", "kc");

    expect(result.currently).toBeNull();
  });

  it("sets awaitingInput when the last AWAIT follows the last RESUME on a running pod", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "[harness] BANDOLIER_RESUME",
        "Fixing the test",
        "[harness] BANDOLIER_AWAIT_INPUT",
      ].join("\n"),
    );

    const result = await inspectPod("pod-await", "ns-await", "Running", "kc");

    expect(result.awaitingInput).toBe(true);
    expect(result.currently).toBe("Fixing the test");
  });

  it("clears awaitingInput on a terminal pod even when AWAIT is the last marker", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "[harness] BANDOLIER_RESUME",
        "wrapping up",
        "[harness] BANDOLIER_AWAIT_INPUT",
      ].join("\n"),
    );

    // Same log as the awaiting case, but a Succeeded pod is done: no input pending.
    const result = await inspectPod(
      "pod-term-await",
      "ns-term-await",
      "Succeeded",
      "kc",
    );

    expect(result.awaitingInput).toBe(false);
  });

  it("clears awaitingInput when a RESUME follows the last AWAIT", async () => {
    readNamespacedPodLog.mockResolvedValue(
      [
        "[harness] BANDOLIER_AWAIT_INPUT",
        "[harness] BANDOLIER_RESUME",
        "back to work",
      ].join("\n"),
    );

    const result = await inspectPod(
      "pod-resumed",
      "ns-resumed",
      "Running",
      "kc",
    );

    expect(result.awaitingInput).toBe(false);
  });

  it("leaves awaitingInput false when neither AWAIT nor RESUME is present", async () => {
    readNamespacedPodLog.mockResolvedValue("just working\n");

    const result = await inspectPod(
      "pod-nomarkers",
      "ns-nomarkers",
      "Running",
      "kc",
    );

    expect(result.awaitingInput).toBe(false);
  });
});

describe("inspectPod caching", () => {
  it("shares one log read between two running-phase calls within the TTL", async () => {
    readNamespacedPodLog.mockResolvedValue("doing things\n");

    const first = await inspectPod(
      "pod-ttl-hit",
      "ns-ttl-hit",
      "Running",
      "kc",
    );
    const second = await inspectPod(
      "pod-ttl-hit",
      "ns-ttl-hit",
      "Running",
      "kc",
    );

    // Second call is served the cached in-flight inspection, not a fresh read.
    expect(readNamespacedPodLog).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-reads once the running-phase TTL has elapsed", async () => {
    vi.useFakeTimers();
    readNamespacedPodLog.mockResolvedValue("progress\n");

    await inspectPod("pod-ttl-exp", "ns-ttl-exp", "Running", "kc");
    // Advance past RUNNING_INSPECTION_TTL_MS (3s).
    vi.advanceTimersByTime(3_001);
    await inspectPod("pod-ttl-exp", "ns-ttl-exp", "Running", "kc");

    expect(readNamespacedPodLog).toHaveBeenCalledTimes(2);
  });

  it("caches a terminal read forever under a key distinct from the running one", async () => {
    vi.useFakeTimers();
    readNamespacedPodLog.mockResolvedValue("finished\n");

    // A running read populates the running key.
    await inspectPod("pod-term", "ns-term", "Running", "kc");
    // The terminal read uses a distinct key, so it does not hit the running
    // cache — a second read fires.
    await inspectPod("pod-term", "ns-term", "Succeeded", "kc");
    expect(readNamespacedPodLog).toHaveBeenCalledTimes(2);

    // Terminal entries have an Infinity freshUntil: even far in the future the
    // terminal read is served from cache.
    vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 30);
    await inspectPod("pod-term", "ns-term", "Succeeded", "kc");
    expect(readNamespacedPodLog).toHaveBeenCalledTimes(2);
  });

  it("evicts the running-phase entry when a terminal inspection is computed", async () => {
    readNamespacedPodLog.mockResolvedValue("output\n");

    await inspectPod("pod-evict", "ns-evict", "Running", "kc"); // read #1
    await inspectPod("pod-evict", "ns-evict", "Failed", "kc"); // read #2, deletes running
    // The running entry was deleted, so a fresh running poll must re-read
    // rather than being served a now-stale cached running inspection.
    await inspectPod("pod-evict", "ns-evict", "Running", "kc"); // read #3

    expect(readNamespacedPodLog).toHaveBeenCalledTimes(3);
  });

  it("resolves a rejected read to the empty fallback and evicts so the next call retries", async () => {
    readNamespacedPodLog.mockRejectedValueOnce(new Error("k8s unreachable"));

    const failed = await inspectPod("pod-rej", "ns-rej", "Running", "kc");
    // The read failed, so the caller gets the neutral fallback, not a throw.
    expect(failed).toEqual(EMPTY_FALLBACK);

    // The catch evicted the cache entry, so a subsequent poll re-reads (here the
    // read succeeds) instead of being served the fallback for the rest of the TTL.
    readNamespacedPodLog.mockResolvedValue("recovered\n");
    const recovered = await inspectPod("pod-rej", "ns-rej", "Running", "kc");

    expect(readNamespacedPodLog).toHaveBeenCalledTimes(2);
    expect(recovered.currently).toBe("recovered");
  });

  it("coalesces concurrent callers arriving before the first read resolves onto one read", async () => {
    // A pending read the test resolves by hand, so both callers are in flight
    // simultaneously against an empty cache.
    let resolveLog: ((value: string) => void) | undefined;
    readNamespacedPodLog.mockReturnValue(
      new Promise<string>((res) => {
        resolveLog = res;
      }),
    );

    const first = inspectPod("pod-coalesce", "ns-coalesce", "Running", "kc");
    const second = inspectPod("pod-coalesce", "ns-coalesce", "Running", "kc");
    // The second call found the first's in-flight promise already cached.
    expect(readNamespacedPodLog).toHaveBeenCalledTimes(1);

    resolveLog?.("shared work\n");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(readNamespacedPodLog).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.currently).toBe("shared work");
  });
});
