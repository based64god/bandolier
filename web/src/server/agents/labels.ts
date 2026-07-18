import crypto from "crypto";

// Kubernetes label values must be ≤63 chars and match
// [a-z0-9A-Z]([a-z0-9A-Z._-]*[a-z0-9A-Z])?. Most user ids already qualify; any
// that don't are hashed to a stable, label-safe value.
const LABEL_SAFE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Pod label holding the Bandolier user id that spawned the agent/task, so the
 * cross-repo overview can query only that user's pods.
 */
export const SPAWNED_BY_LABEL = "bandolier.io/spawned-by";

/**
 * Name of the harness container in every agent pod (see create-job's pod spec).
 * Reads of a running pod's logs must name it explicitly: a cluster that injects
 * a sidecar (e.g. a service mesh) makes the pod multi-container, and then a
 * container-unspecified `readNamespacedPodLog` errors ("a container name must be
 * specified") instead of returning the harness's logs. Kept here — a dependency-
 * free module — so the creator and the log readers share one source of truth.
 */
export const AGENT_CONTAINER_NAME = "harness";

/**
 * Encodes a user id as a Kubernetes-label-safe value, stable across calls so the
 * same id always yields the same selector. Used to tag agent pods with the user
 * who spawned them and to query only that user's pods.
 */
export function spawnedByLabelValue(userId: string): string {
  if (LABEL_SAFE.test(userId)) return userId;
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 63);
}
