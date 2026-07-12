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
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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

type K8sObject = Record<string, unknown> & {
  metadata?: Record<string, unknown>;
};

// The subset of a Job body the pod synthesis reads.
type JobBody = {
  metadata?: { name?: string };
  spec?: {
    template?: {
      metadata?: {
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
    };
  };
};

export type FakeK8s = {
  url: string;
  store: { podsByNs: Map<string, K8sObject[]> };
  close: () => Promise<void>;
};

const LOG_RE = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/;
const PODS_RE = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/;
const JOBS_RE = /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs$/;
const SA_RE = /^\/api\/v1\/namespaces\/[^/]+\/serviceaccounts$/;
const SECRET_RE = /^\/api\/v1\/namespaces\/[^/]+\/secrets$/;
const NETPOL_RE =
  /^\/apis\/networking\.k8s\.io\/v1\/namespaces\/[^/]+\/networkpolicies/;
const PDB_RE = /^\/apis\/policy\/v1\/namespaces\/[^/]+\/poddisruptionbudgets$/;

function readBody(req: IncomingMessage): Promise<K8sObject> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as K8sObject) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function startFakeK8s(): Promise<FakeK8s> {
  // Pods synthesized by job creations, keyed by namespace.
  const store = { podsByNs: new Map<string, K8sObject[]>() };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "GET";
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const text = (status: number, body: string): void => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    // Echo a created object back with kind/apiVersion/uid filled in — enough for
    // the typed client to deserialize it.
    const created = (kind: string, apiVersion: string, body: K8sObject): void =>
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
    const logMatch = LOG_RE.exec(path);
    if (method === "GET" && logMatch) {
      return text(
        200,
        `[harness] pod ${logMatch[2]} started\n${FAKE_LOG_LINE}\n`,
      );
    }

    // ── list pods (dashboard task list) ──────────────────────────────────────
    const podsMatch = PODS_RE.exec(path);
    if (method === "GET" && podsMatch) {
      const ns = podsMatch[1] ?? "";
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
    const jobMatch = JOBS_RE.exec(path);
    if (method === "POST" && jobMatch) {
      const ns = jobMatch[1] ?? "";
      const body = (await readBody(req)) as JobBody & K8sObject;
      const jobName = body.metadata?.name ?? `bandolier-agent-${Date.now()}`;
      const tmpl = body.spec?.template?.metadata ?? {};
      const pod: K8sObject = {
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
    if (method === "POST" && path === "/api/v1/namespaces") {
      return created("Namespace", "v1", await readBody(req));
    }
    if (method === "POST" && SA_RE.test(path)) {
      return created("ServiceAccount", "v1", await readBody(req));
    }
    if (method === "POST" && SECRET_RE.test(path)) {
      return created("Secret", "v1", await readBody(req));
    }
    if (NETPOL_RE.test(path)) {
      const status = method === "POST" ? 201 : 200;
      return json(status, {
        kind: "NetworkPolicy",
        apiVersion: "networking.k8s.io/v1",
        ...(await readBody(req)),
      });
    }
    if (method === "POST" && PDB_RE.test(path)) {
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
  };

  const server = http.createServer((req, res) => void handle(req, res));

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
