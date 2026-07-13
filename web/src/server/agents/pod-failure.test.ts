import { describe, expect, it } from "vitest";

import type { V1Pod } from "@kubernetes/client-node";

import { podFailure } from "~/server/agents/pod-failure";

function pod(status: V1Pod["status"]): V1Pod {
  return { status };
}

describe("podFailure", () => {
  it("returns null for a non-Failed pod", () => {
    expect(podFailure(pod({ phase: "Running" }))).toBeNull();
    expect(podFailure(pod({ phase: "Succeeded" }))).toBeNull();
    expect(podFailure(pod(undefined))).toBeNull();
  });

  it("surfaces an OOM kill from the container termination state", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          containerStatuses: [
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "OOMKilled", exitCode: 137, message: null });
  });

  it("finds an OOM kill recorded in lastState across a restart", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          containerStatuses: [
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 1,
              lastState: {
                terminated: { reason: "OOMKilled", exitCode: 137 },
              },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "OOMKilled", exitCode: 137, message: null });
  });

  it("prefers the OOM kill over a pod-level reason", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          reason: "DeadlineExceeded",
          containerStatuses: [
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "OOMKilled", exitCode: 137, message: null });
  });

  it("surfaces a pod-level eviction with its message", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          reason: "Evicted",
          message: "The node was low on resource: memory.",
        }),
      ),
    ).toEqual({
      reason: "Evicted",
      exitCode: null,
      message: "The node was low on resource: memory.",
    });
  });

  it("prefers a pod-level reason over a generic container exit code", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          reason: "DeadlineExceeded",
          containerStatuses: [
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { terminated: { reason: "Error", exitCode: 143 } },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "DeadlineExceeded", exitCode: null, message: null });
  });

  it("reports a crashed container's exit code and message", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          containerStatuses: [
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: {
                terminated: {
                  reason: "Error",
                  exitCode: 1,
                  message: "panic: boom",
                },
              },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "Error", exitCode: 1, message: "panic: boom" });
  });

  it("skips containers that exited cleanly to find the failed one", () => {
    expect(
      podFailure(
        pod({
          phase: "Failed",
          containerStatuses: [
            {
              name: "sidecar",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { terminated: { reason: "Completed", exitCode: 0 } },
            },
            {
              name: "agent",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { terminated: { exitCode: 2 } },
            },
          ],
        }),
      ),
    ).toEqual({ reason: "Error", exitCode: 2, message: null });
  });

  it("falls back to a generic Error when the status carries no detail", () => {
    expect(podFailure(pod({ phase: "Failed" }))).toEqual({
      reason: "Error",
      exitCode: null,
      message: null,
    });
  });
});
