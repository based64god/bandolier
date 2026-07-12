// Orchestrates the browser PRODUCT-FLOW tests under e2e/*.flow.ts — the real
// authenticated/gated product surface, as opposed to the isolated /dev/* fixture
// smoke tests that e2e/run.ts drives. This runner:
//
//   1. boots `next dev` on PORT (default 3138) with the shared-password gate
//      ENABLED (APP_PASSWORD set), so the flow specs can exercise it,
//   2. waits until the exempt routes (/gate, /api/version) answer 200,
//   3. runs each e2e/*.flow.ts spec in turn, streaming its output,
//   4. tears the server down and exits non-zero if any spec failed.
//
// It is a sibling of run.ts (own port, own *.flow.ts glob, own env) so the two
// suites never collide. The heavier authenticated flows (deploy → pod → logs,
// settings persistence) build on this runner plus a real DATABASE_URL, a fake
// Kubernetes server, and the better-auth session bypass; the password-gate spec
// here is fully hermetic (no DB/k8s/GitHub) and proves the runner itself.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3138);
const externalBase = process.env.E2E_BASE_URL;
const base = externalBase ?? `http://localhost:${port}`;

// The gate password the specs submit. Fixed here (and exported to the specs via
// E2E_APP_PASSWORD) so the server and the spec agree.
const APP_PASSWORD = process.env.E2E_APP_PASSWORD ?? "flow-gate-secret";

// Exempt routes answer 200 even while gated, so they're the readiness signal.
const ROUTES = ["/gate", "/api/version"];

// Inert placeholders for the vars env.js validates at import time, plus the gate
// password. The flow specs that stay on exempt/gate paths contact no real
// services, so any syntactically valid value works.
const PLACEHOLDER_ENV = {
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: "flow-e2e",
  BETTER_AUTH_GITHUB_CLIENT_ID: "flow-e2e",
  BETTER_AUTH_GITHUB_CLIENT_SECRET: "flow-e2e",
  DATABASE_URL: "postgres://e2e:e2e@localhost:5432/e2e",
  APP_PASSWORD,
};

function log(msg: string): void {
  console.log(`[flow-e2e] ${msg}`);
}

async function waitForRoutes(timeoutMs = 90_000) {
  const start = performance.now();
  for (;;) {
    let allUp = true;
    for (const route of ROUTES) {
      try {
        const res = await fetch(`${base}${route}`);
        if (res.status !== 200) allUp = false;
      } catch {
        allUp = false;
      }
      if (!allUp) break;
    }
    if (allUp) return;
    if (performance.now() - start > timeoutMs) {
      throw new Error(`routes not ready after ${timeoutMs}ms: ${base}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function runNode(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE_URL: base,
        E2E_APP_PASSWORD: APP_PASSWORD,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let server: ChildProcess | undefined;
function startServer() {
  log(`starting next dev on port ${port} (gate enabled)`);
  server = spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...PLACEHOLDER_ENV, ...process.env, APP_PASSWORD },
    detached: true,
  });
}

function stopServer() {
  if (server && !server.killed && server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      try {
        server.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    }
  }
}

const specs = readdirSync(here)
  .filter((f) => f.endsWith(".flow.ts"))
  .sort();

if (specs.length === 0) {
  log("no *.flow.ts files found");
  process.exit(0);
}

process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

try {
  if (!externalBase) startServer();
  log(`waiting for ${base} …`);
  await waitForRoutes();
  log(`server ready, running ${specs.length} flow spec(s)`);

  let failed = 0;
  for (const spec of specs) {
    log(`▶ ${spec}`);
    const code = await runNode(join(here, spec));
    if (code !== 0) {
      failed++;
      log(`✗ ${spec} (exit ${code})`);
    } else {
      log(`✓ ${spec}`);
    }
  }

  stopServer();
  if (failed > 0) {
    log(`${failed}/${specs.length} flow spec(s) failed`);
    process.exit(1);
  }
  log(`all ${specs.length} flow spec(s) passed`);
  process.exit(0);
} catch (err) {
  console.error(err);
  stopServer();
  process.exit(1);
}
