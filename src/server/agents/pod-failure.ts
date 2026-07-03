import type { V1Pod } from "@kubernetes/client-node";

/**
 * Distilled cause of a Failed pod. The pod phase alone ("Failed") hides the
 * actual story — an OOM kill, an eviction, a crashed process — which lives in
 * the container termination states and pod-level status fields. The dashboard
 * uses this to explain the failure and suggest a fix.
 */
export interface PodFailure {
  /** Kubernetes reason, e.g. "OOMKilled", "Evicted", "Error". */
  reason: string;
  /** The container's exit code, when a container got far enough to have one. */
  exitCode: number | null;
  /** Free-text detail from Kubernetes (e.g. an eviction message), if any. */
  message: string | null;
}

export function podFailure(pod: V1Pod): PodFailure | null {
  if (pod.status?.phase !== "Failed") return null;

  // Container termination states carry the kill reason. Agent jobs run with
  // restartPolicy Never so there's at most one termination per container, but
  // lastState is included in case the status straddled a restart.
  const terminations = (pod.status.containerStatuses ?? [])
    .flatMap((c) => [c.state?.terminated, c.lastState?.terminated])
    .filter((t) => t != null);

  // An OOM kill is the most specific signal — surface it even when a pod-level
  // reason is also present.
  const oom = terminations.find((t) => t.reason === "OOMKilled");
  if (oom) {
    return {
      reason: "OOMKilled",
      exitCode: oom.exitCode ?? null,
      message: oom.message ?? null,
    };
  }

  // Pod-level failures (Evicted, DeadlineExceeded) explain the kill better
  // than the container's generic SIGTERM/SIGKILL exit code.
  if (pod.status.reason) {
    return {
      reason: pod.status.reason,
      exitCode: null,
      message: pod.status.message ?? null,
    };
  }

  const crashed = terminations.find((t) => (t.exitCode ?? 0) !== 0);
  if (crashed) {
    return {
      reason: crashed.reason ?? "Error",
      exitCode: crashed.exitCode ?? null,
      message: crashed.message ?? null,
    };
  }

  return { reason: "Error", exitCode: null, message: null };
}
