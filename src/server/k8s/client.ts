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
