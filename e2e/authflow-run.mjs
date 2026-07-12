// Orchestrates the AUTHENTICATED browser product-flow tests under
// e2e/*.authflow.mjs — the real signed-in product surface, backed by a real
// (throwaway) Postgres. Distinct from:
//   - run.mjs        (/dev/* component fixtures, port 3137)
//   - flow-run.mjs   (the shared-password gate, hermetic, port 3138)
// This runner (port 3139):
//   1. migrates + truncates the database at DATABASE_URL,
//   2. boots `next dev` against it with the gate DISABLED,
//   3. waits for the app, then runs each e2e/*.authflow.mjs spec,
//   4. tears the server down and exits non-zero if any spec failed.
//
// Specs mint a real better-auth session by POSTing /api/auth/sign-up/email and
// carry the returned cookie, and seed extra rows via e2e/db.mjs — no GitHub
// OAuth and no reverse-engineering of cookie signing. Flows that need a cluster
// point a seeded kubeconfig at the fake Kubernetes server (e2e/fake-k8s.mjs).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { connect, migrateDb, resetDb } from "./db.mjs";
import { startFakeK8s } from "./fake-k8s.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3139);
const externalBase = process.env.E2E_BASE_URL;
const base = externalBase ?? `http://localhost:${port}`;

// A real, throwaway Postgres. Locally defaults to the same test container the
// integration suite uses; CI supplies a service container.
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://test:test@localhost:5433/bandolier_test";

const SERVER_ENV = {
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: "authflow-e2e",
  BETTER_AUTH_GITHUB_CLIENT_ID: "authflow-e2e",
  BETTER_AUTH_GITHUB_CLIENT_SECRET: "authflow-e2e",
  DATABASE_URL: databaseUrl,
  // Gate DISABLED for authed flows (no APP_PASSWORD).
};

function log(msg) {
  console.log(`[authflow-e2e] ${msg}`);
}

async function waitForRoutes(timeoutMs = 120_000) {
  const routes = ["/", "/api/version"];
  const start = performance.now();
  for (;;) {
    let allUp = true;
    for (const route of routes) {
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

let fakeK8sUrl = process.env.E2E_FAKE_K8S_URL ?? "";

function runNode(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE_URL: base,
        DATABASE_URL: databaseUrl,
        E2E_FAKE_K8S_URL: fakeK8sUrl,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// Intercept the server's own GitHub calls (Playwright can't reach them) by
// preloading a global-fetch stub into the Next server process.
const preload = pathToFileURL(join(here, "stub-preload.mjs")).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import ${preload}`]
  .filter(Boolean)
  .join(" ");

let server;
function startServer() {
  log(`starting next dev on port ${port} (gate disabled, real DB)`);
  server = spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...SERVER_ENV,
      ...process.env,
      ...SERVER_ENV,
      NODE_OPTIONS: nodeOptions,
    },
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
  .filter((f) => f.endsWith(".authflow.mjs"))
  .sort();

if (specs.length === 0) {
  log("no *.authflow.mjs files found");
  process.exit(0);
}

process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

let sql;
let fakeK8s;
try {
  log(`migrating + resetting ${databaseUrl}`);
  sql = connect();
  await migrateDb(sql);
  await resetDb(sql);
  await sql.end();
  sql = undefined;

  // The app (Next server, same host) reaches this on loopback; specs read its
  // URL to build the kubeconfig they submit.
  fakeK8s = await startFakeK8s();
  fakeK8sUrl = fakeK8s.url;
  log(`fake Kubernetes at ${fakeK8sUrl}`);

  if (!externalBase) startServer();
  log(`waiting for ${base} …`);
  await waitForRoutes();
  log(`server ready, running ${specs.length} authflow spec(s)`);

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
  if (fakeK8s) await fakeK8s.close().catch(() => {});
  if (failed > 0) {
    log(`${failed}/${specs.length} authflow spec(s) failed`);
    process.exit(1);
  }
  log(`all ${specs.length} authflow spec(s) passed`);
  process.exit(0);
} catch (err) {
  console.error(err);
  if (sql) await sql.end().catch(() => {});
  if (fakeK8s) await fakeK8s.close().catch(() => {});
  stopServer();
  process.exit(1);
}
