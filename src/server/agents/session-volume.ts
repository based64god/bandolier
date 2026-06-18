import { PassThrough } from "stream";

import type * as k8s from "@kubernetes/client-node";

import { env } from "~/env";
import { getCoreV1Api, getExec, getStorageV1Api } from "~/server/k8s/client";

/**
 * Per-thread session volumes.
 *
 * Each session thread (a chain of related runs in one repo) is backed by a
 * PersistentVolumeClaim that holds Claude's `~/.claude` state. Child pods mount
 * it directly at /root/.claude, so resuming is a *local* read — no broker. The
 * broker-pod exec path here is used only for the MCP discovery reads, where the
 * API needs to peek at *another* thread's PVC it hasn't mounted (the
 * kube-apiserver exposes PVC objects but not their file bytes, so the only way
 * to read a volume is to mount it into a running pod and stream `tar` out).
 */

export type AccessMode = "ReadWriteOnce" | "ReadWriteMany";

/** Label marking a PVC as a Bandolier session-thread volume + its thread id. */
export const THREAD_LABEL = "bandolier.io/thread";

/** Where each child pod mounts its thread PVC. Matches HOME=/root in the image. */
export const SESSION_MOUNT_PATH = "/root/.claude";

/** Whether cross-task session persistence is switched on. */
export function sessionPersistenceEnabled(): boolean {
  return env.SESSION_PERSISTENCE === "true";
}

/** Deterministic PVC name for a thread (DNS-1123: lowercase, ≤63 chars). */
export function threadPvcName(threadId: string): string {
  return `bandolier-session-${threadId}`.toLowerCase().slice(0, 63);
}

// Provisioners known to support ReadWriteMany. RWX needs a shared filesystem
// (NFS/EFS/CephFS/Azure File/Filestore); block-device provisioners (EBS, GCE PD,
// most CSI block drivers) are RWO-only. Anything not listed defaults to RWO,
// which is always safe — concurrent children then seed via the broker-cp path
// instead of mounting. Override per-cluster with SESSION_PVC_ACCESS_MODES.
const RWX_PROVISIONERS = [
  "efs.csi.aws.com",
  "filestore.csi.storage.gke.io",
  "file.csi.azure.com",
  "cephfs.csi.ceph.com",
  "nfs.csi.k8s.io",
  "smb.csi.k8s.io",
  /\bnfs\b/, // legacy in-tree / generic nfs provisioners
  /cephfs/,
];

/**
 * Resolves the access mode to provision a session PVC with, discovered from the
 * StorageClass's provisioner. Order: explicit override env → provisioner
 * capability map → default RWO (always safe).
 */
export async function resolveAccessMode(
  kubeconfig: string,
): Promise<AccessMode> {
  if (env.SESSION_PVC_ACCESS_MODES) return env.SESSION_PVC_ACCESS_MODES;

  try {
    const storage = getStorageV1Api(kubeconfig);
    let provisioner: string | undefined;
    const scName = env.SESSION_PVC_STORAGE_CLASS;
    if (scName) {
      const sc = await storage.readStorageClass({ name: scName });
      provisioner = sc.provisioner;
    } else {
      // No SC configured — find the cluster's default StorageClass.
      const list = await storage.listStorageClass();
      const def = list.items.find(
        (sc) =>
          sc.metadata?.annotations?.[
            "storageclass.kubernetes.io/is-default-class"
          ] === "true",
      );
      provisioner = def?.provisioner;
    }

    if (provisioner) {
      const p = provisioner.toLowerCase();
      const rwx = RWX_PROVISIONERS.some((m) =>
        typeof m === "string" ? p === m : m.test(p),
      );
      if (rwx) return "ReadWriteMany";
    }
  } catch {
    // SC not readable (RBAC, missing) — fall back to the safe default.
  }
  return "ReadWriteOnce";
}

/** OwnerReference pointing a PVC at the Job whose lifetime should bound it. */
function jobOwnerRef(jobName: string, jobUid: string): k8s.V1OwnerReference {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    name: jobName,
    uid: jobUid,
    blockOwnerDeletion: true,
  };
}

/**
 * Creates the thread's PVC if absent, or returns the existing one (409 = reuse,
 * which races resolve to naturally). The PVC is owned by the creating child Job
 * so it is garbage-collected one Job-TTL after that child — `reparentPvc` moves
 * the owner to each newer child so the volume "lives as long as the most recent
 * child".
 */
export async function ensureThreadPvc(args: {
  kubeconfig: string;
  namespace: string;
  threadId: string;
  accessMode: AccessMode;
  ownerJobName: string;
  ownerJobUid: string;
}): Promise<{ pvcName: string; created: boolean }> {
  const core = getCoreV1Api(args.kubeconfig);
  const pvcName = threadPvcName(args.threadId);

  try {
    await core.createNamespacedPersistentVolumeClaim({
      namespace: args.namespace,
      body: {
        metadata: {
          name: pvcName,
          namespace: args.namespace,
          labels: {
            "app.kubernetes.io/managed-by": "bandolier",
            [THREAD_LABEL]: args.threadId,
          },
          ownerReferences: [jobOwnerRef(args.ownerJobName, args.ownerJobUid)],
        },
        spec: {
          accessModes: [args.accessMode],
          resources: { requests: { storage: env.SESSION_PVC_SIZE } },
          ...(env.SESSION_PVC_STORAGE_CLASS && {
            storageClassName: env.SESSION_PVC_STORAGE_CLASS,
          }),
        },
      },
    });
    return { pvcName, created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 409) {
      return { pvcName, created: false };
    }
    throw err;
  }
}

/**
 * Re-parents the thread PVC to the newest child Job by replacing its
 * ownerReferences, so K8s GC tracks the most recent child. Retries once on a
 * conflict (409). Best-effort: a failure here only means the PVC is GC'd against
 * the previous child, not lost.
 */
export async function reparentPvc(args: {
  kubeconfig: string;
  namespace: string;
  pvcName: string;
  ownerJobName: string;
  ownerJobUid: string;
}): Promise<void> {
  const core = getCoreV1Api(args.kubeconfig);
  const body = {
    metadata: {
      ownerReferences: [jobOwnerRef(args.ownerJobName, args.ownerJobUid)],
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await core.patchNamespacedPersistentVolumeClaim({
        name: args.pvcName,
        namespace: args.namespace,
        body,
      });
      return;
    } catch (err) {
      if ((err as { code?: number }).code === 409 && attempt === 0) continue;
      throw err;
    }
  }
}

/** Image used for the transient broker pod: explicit override, else the harness. */
function brokerImage(harnessImage: string): string {
  return env.SESSION_BROKER_IMAGE ?? harnessImage;
}

/**
 * Reads a thread's `~/.claude/projects/` as a gzipped tar by spawning a
 * short-lived, network-isolated broker pod that mounts the thread PVC read-only,
 * then `tar`-streaming the bytes out over `exec`. Returns null if the thread has
 * no PVC / no session yet. The broker pod is always deleted, even on error.
 *
 * This is only for MCP discovery peeks at *other* threads' PVCs — a child
 * resuming its own thread reads the locally-mounted volume directly.
 */
export async function readThreadSession(args: {
  kubeconfig: string;
  namespace: string;
  pvcName: string;
  harnessImage: string;
}): Promise<Buffer | null> {
  const core = getCoreV1Api(args.kubeconfig);
  const podName = `bandolier-broker-${args.pvcName}`.slice(0, 63);

  // Spawn the broker: mounts the PVC read-only, sleeps so we can exec into it.
  try {
    await core.createNamespacedPod({
      namespace: args.namespace,
      body: {
        metadata: {
          name: podName,
          namespace: args.namespace,
          labels: {
            app: "bandolier-agent", // inherits the namespace NetworkPolicy
            "app.kubernetes.io/managed-by": "bandolier",
            "bandolier.io/role": "session-broker",
          },
        },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          activeDeadlineSeconds: 120, // hard ceiling so a stuck broker self-reaps
          securityContext: { runAsUser: 0, runAsGroup: 0, fsGroup: 0 },
          containers: [
            {
              name: "broker",
              image: brokerImage(args.harnessImage),
              command: ["sleep", "100"],
              volumeMounts: [
                { name: "session", mountPath: "/claude", readOnly: true },
              ],
            },
          ],
          volumes: [
            {
              name: "session",
              persistentVolumeClaim: {
                claimName: args.pvcName,
                readOnly: true,
              },
            },
          ],
        },
      },
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 409) throw err;
    // A broker for this PVC already exists (concurrent read) — reuse it.
  }

  try {
    await waitForPodRunning(args.kubeconfig, args.namespace, podName);

    const exec = getExec(args.kubeconfig);
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c));
    const stderr = new PassThrough();

    const done = new Promise<void>((resolve, reject) => {
      stdout.on("end", resolve);
      stdout.on("error", reject);
    });

    // `|| true` so an empty/missing projects dir exits 0 with empty output
    // rather than erroring the stream.
    await exec.exec(
      args.namespace,
      podName,
      "broker",
      ["sh", "-c", "tar czf - -C /claude projects 2>/dev/null || true"],
      stdout,
      stderr,
      null,
      false,
    );
    await done;

    const buf = Buffer.concat(chunks);
    return buf.length > 0 ? buf : null;
  } finally {
    await core
      .deleteNamespacedPod({ name: podName, namespace: args.namespace })
      .catch(() => undefined);
  }
}

/** Polls a pod until it reports phase Running, up to ~30s. */
async function waitForPodRunning(
  kubeconfig: string,
  namespace: string,
  podName: string,
): Promise<void> {
  const core = getCoreV1Api(kubeconfig);
  for (let i = 0; i < 60; i++) {
    const pod = await core.readNamespacedPod({ name: podName, namespace });
    const phase = pod.status?.phase;
    if (phase === "Running") return;
    if (phase === "Failed" || phase === "Succeeded") {
      throw new Error(`broker pod ${podName} terminated early (${phase})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`broker pod ${podName} did not become ready in time`);
}
