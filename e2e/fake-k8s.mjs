// A fake Kubernetes API server for the authenticated browser flows. The seam is
// the kubeconfig's server URL: point a seeded/submitted kubeconfig at this
// server and the app's @kubernetes/client-node calls land here instead of a real
// cluster, so a flow can validate a kubeconfig (GET /version) — and, once the
// deploy endpoints are fleshed out, deploy a job and observe the synthesized
// pod — entirely hermetically.
//
// It answers plain HTTP (the submitted kubeconfig uses http://127.0.0.1:<port>
// with an inline token), so no TLS/CA material is needed.
import http from "node:http";

const K8S_VERSION = {
  major: "1",
  minor: "29",
  gitVersion: "v1.29.0-fake",
  gitCommit: "fake",
  gitTreeState: "clean",
  buildDate: "2024-01-01T00:00:00Z",
  goVersion: "go1.21",
  compiler: "gc",
  platform: "linux/amd64",
};

// startFakeK8s listens on an ephemeral loopback port and resolves to
// { url, close }. store is exposed for future deploy-flow endpoints.
export function startFakeK8s() {
  const store = { pods: [] };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // The kubeconfig-validation probe: GET {server}/version.
    if (req.method === "GET" && path === "/version") {
      return json(200, K8S_VERSION);
    }

    // Everything else is unimplemented for now (the settings flow needs only
    // /version). A Kubernetes-shaped 404 keeps client errors legible; the deploy
    // flow will add namespaces/serviceaccounts/secrets/jobs/pods/logs here.
    return json(404, {
      kind: "Status",
      apiVersion: "v1",
      status: "Failure",
      message: `fake-k8s: unhandled ${req.method} ${path}`,
      reason: "NotFound",
      code: 404,
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
