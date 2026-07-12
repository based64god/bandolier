// A fake Kubernetes API server for the authenticated browser flows. The seam is
// the kubeconfig's server URL: point a seeded/submitted kubeconfig at this
// server and the app's @kubernetes/client-node calls land here instead of a real
// cluster. It answers plain HTTP (the kubeconfig uses http://127.0.0.1:<port>
// with insecure-skip-tls-verify + an inline token), so no TLS material is needed.
//
// It implements the subset the app exercises:
//   - GET /version                                   (kubeconfig validation)
//   - POST namespaces / serviceaccounts / secrets /
//     networkpolicies / poddisruptionbudgets         (createAgentJob bootstrap)
//   - POST batch/v1 jobs → synthesizes a Running pod carrying the job template's
//     labels + annotations, so a later pod list returns it (deploy → observe)
//   - GET pods (+labelSelector, ignored) → the synthesized pods
//   - GET pods/{name}/log → a canned log line (inspectPod + getLogs)
import http from "node:http";
import { randomUUID } from "node:crypto";

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

// A recognizable log line the deploy spec asserts appears in the LogModal.
export const FAKE_LOG_LINE = "e2e-fake-agent-log: working on the task";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function startFakeK8s() {
  // Pods synthesized by job creations, keyed by namespace.
  const store = { podsByNs: new Map() };

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const method = req.method ?? "GET";
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const text = (status, body) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    // Echo a created object back with kind/apiVersion/uid filled in — enough for
    // the typed client to deserialize it.
    const created = (kind, apiVersion, body) =>
      json(201, {
        kind,
        apiVersion,
        ...body,
        metadata: {
          ...(body.metadata ?? {}),
          uid: body.metadata?.uid ?? randomUUID(),
          creationTimestamp: new Date().toISOString(),
        },
      });

    // ── kubeconfig validation ────────────────────────────────────────────────
    if (method === "GET" && path === "/version") {
      return json(200, K8S_VERSION);
    }

    // ── pod log (inspectPod + getLogs) ───────────────────────────────────────
    const logMatch = path.match(
      /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/,
    );
    if (method === "GET" && logMatch) {
      return text(
        200,
        `[harness] pod ${logMatch[2]} started\n${FAKE_LOG_LINE}\n`,
      );
    }

    // ── list pods (dashboard task list) ──────────────────────────────────────
    const podsMatch = path.match(/^\/api\/v1\/namespaces\/([^/]+)\/pods$/);
    if (method === "GET" && podsMatch) {
      const ns = podsMatch[1];
      return json(200, {
        kind: "PodList",
        apiVersion: "v1",
        metadata: { resourceVersion: "1" },
        items: store.podsByNs.get(ns) ?? [],
      });
    }
    // list pods across all namespaces (home overview) — return everything.
    if (method === "GET" && path === "/api/v1/pods") {
      return json(200, {
        kind: "PodList",
        apiVersion: "v1",
        metadata: { resourceVersion: "1" },
        items: [...store.podsByNs.values()].flat(),
      });
    }

    // ── job creation → synthesize a Running pod ──────────────────────────────
    const jobMatch = path.match(
      /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs$/,
    );
    if (method === "POST" && jobMatch) {
      const ns = jobMatch[1];
      const body = await readBody(req);
      const jobName = body.metadata?.name ?? `bandolier-agent-${Date.now()}`;
      const tmpl = body.spec?.template?.metadata ?? {};
      const pod = {
        kind: "Pod",
        apiVersion: "v1",
        metadata: {
          name: `${jobName}-${Math.random().toString(36).slice(2, 7)}`,
          namespace: ns,
          uid: randomUUID(),
          creationTimestamp: new Date().toISOString(),
          labels: tmpl.labels ?? {},
          annotations: tmpl.annotations ?? {},
        },
        spec: { containers: [{ name: "agent", image: "bandolier/agent" }] },
        status: {
          phase: "Running",
          startTime: new Date().toISOString(),
          containerStatuses: [
            {
              name: "agent",
              ready: true,
              started: true,
              restartCount: 0,
              image: "bandolier/agent",
              imageID: "",
              state: { running: { startedAt: new Date().toISOString() } },
            },
          ],
        },
      };
      const pods = store.podsByNs.get(ns) ?? [];
      pods.push(pod);
      store.podsByNs.set(ns, pods);
      return created("Job", "batch/v1", body);
    }

    // ── bootstrap resources: accept every create/replace ─────────────────────
    if (
      method === "POST" &&
      path === "/api/v1/namespaces"
    ) {
      return created("Namespace", "v1", await readBody(req));
    }
    if (
      method === "POST" &&
      /^\/api\/v1\/namespaces\/[^/]+\/serviceaccounts$/.test(path)
    ) {
      return created("ServiceAccount", "v1", await readBody(req));
    }
    if (
      method === "POST" &&
      /^\/api\/v1\/namespaces\/[^/]+\/secrets$/.test(path)
    ) {
      return created("Secret", "v1", await readBody(req));
    }
    if (
      /^\/apis\/networking\.k8s\.io\/v1\/namespaces\/[^/]+\/networkpolicies/.test(
        path,
      )
    ) {
      const status = method === "POST" ? 201 : 200;
      return json(status, {
        kind: "NetworkPolicy",
        apiVersion: "networking.k8s.io/v1",
        ...(await readBody(req)),
      });
    }
    if (
      method === "POST" &&
      /^\/apis\/policy\/v1\/namespaces\/[^/]+\/poddisruptionbudgets$/.test(path)
    ) {
      return created("PodDisruptionBudget", "policy/v1", await readBody(req));
    }

    // Anything else: a Kubernetes-shaped 404 keeps client errors legible.
    return json(404, {
      kind: "Status",
      apiVersion: "v1",
      status: "Failure",
      message: `fake-k8s: unhandled ${method} ${path}`,
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
