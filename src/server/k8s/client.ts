import * as k8s from "@kubernetes/client-node";

/**
 * Builds a KubeConfig from a user-provided kubeconfig string. There is no server
 * fallback — every cluster operation runs against the acting user's own cluster.
 */
function buildKubeConfig(kubeconfig: string): k8s.KubeConfig {
  if (!kubeconfig) {
    throw new Error("No kubeconfig provided.");
  }
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kubeconfig);
  return kc;
}

/**
 * Detects credential mechanisms in the kubeconfig's current context that this
 * server can't satisfy, returning a human-readable reason or null when the
 * config is self-contained (inline token or client certificate).
 *
 * Bandolier runs the Kubernetes client server-side (e.g. on Vercel), so it can't
 * shell out to an exec credential plugin or auth provider (`aws`/`gcloud` — those
 * binaries aren't present, and serverless runtimes can't spawn them), nor read
 * cert/key files referenced by on-disk paths (they don't exist on the server).
 */
export function unsupportedKubeconfigAuth(kubeconfig: string): string | null {
  const kc = buildKubeConfig(kubeconfig);
  const user = kc.getCurrentUser();
  const cluster = kc.getCurrentCluster();

  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

  if (user?.exec) {
    const command = asRecord(user.exec).command;
    return `the selected context authenticates with an exec credential plugin${
      typeof command === "string" ? ` (\`${command}\`)` : ""
    }, which the server can't run`;
  }
  if (user?.authProvider) {
    const name = asRecord(user.authProvider).name;
    return `the selected context uses an auth provider${
      typeof name === "string" ? ` (\`${name}\`)` : ""
    }, which the server can't run`;
  }
  if (user?.certFile ?? user?.keyFile ?? cluster?.caFile) {
    return "the kubeconfig references certificate/key files on disk, which don't exist on the server — inline them as `certificate-authority-data` / `client-certificate-data` / `client-key-data`";
  }
  return null;
}

/** The API-server URL of the kubeconfig's current cluster, or null. */
export function getKubeconfigServer(kubeconfig: string): string | null {
  return buildKubeConfig(kubeconfig).getCurrentCluster()?.server ?? null;
}

export function getCoreV1Api(kubeconfig: string): k8s.CoreV1Api {
  return buildKubeConfig(kubeconfig).makeApiClient(k8s.CoreV1Api);
}

export function getBatchV1Api(kubeconfig: string): k8s.BatchV1Api {
  return buildKubeConfig(kubeconfig).makeApiClient(k8s.BatchV1Api);
}

export function getVersionApi(kubeconfig: string): k8s.VersionApi {
  return buildKubeConfig(kubeconfig).makeApiClient(k8s.VersionApi);
}

export function getNetworkingV1Api(kubeconfig: string): k8s.NetworkingV1Api {
  return buildKubeConfig(kubeconfig).makeApiClient(k8s.NetworkingV1Api);
}
