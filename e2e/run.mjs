// Orchestrates the browser smoke tests under e2e/*.spec.mjs.
//
// Each spec is a standalone Playwright script that drives a dev server serving
// the /dev/* harness routes and exits non-zero on the first failed assertion.
// This runner owns the server lifecycle so the specs (and CI) don't have to:
//
//   1. boot `next dev` on PORT (default 3137),
//   2. wait until every route the specs hit answers 200,
//   3. run each spec in turn, streaming its output,
//   4. tear the server down and exit non-zero if any spec failed.
//
// Usage:
//   node e2e/run.mjs                 # boot a server, run every spec
//   E2E_BASE_URL=… node e2e/run.mjs  # reuse an already-running server
//
// Every spec reads E2E_BASE_URL (via e2e/helpers.mjs), so a single base URL
// configures the whole suite; this runner just points it at the server it boots.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3137);
const externalBase = process.env.E2E_BASE_URL;
const base = externalBase ?? `http://localhost:${port}`;

// Routes the specs depend on. We block on these so a spec never races a
// still-compiling route and reports a spurious failure.
const ROUTES = [
  "/dev/composer",
  "/dev/conversation",
  "/dev/credential-ui",
  "/dev/effort-picker",
  "/dev/modal",
  "/dev/searchable-select",
  "/dev/status-badge",
  "/dev/task-row",
];

// Inert placeholders for the handful of vars env.js validates at import time.
// The /dev/* routes contact no real services, so any syntactically valid value
// works; a caller's real values (or SKIP_ENV_VALIDATION) take precedence.
const PLACEHOLDER_ENV = {
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: "e2e",
  BETTER_AUTH_GITHUB_CLIENT_ID: "e2e",
  BETTER_AUTH_GITHUB_CLIENT_SECRET: "e2e",
  DATABASE_URL: "postgres://e2e:e2e@localhost:5432/e2e",
};

function log(msg) {
  console.log(`[e2e] ${msg}`);
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

function runNode(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE_URL: base,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let server;
function startServer() {
  log(`starting next dev on port ${port}`);
  // `detached: true` puts next in its own process group so stopServer() can
  // signal the whole tree. Going through a shell wrapper (pnpm/npx) would leave
  // next as an un-signalled grandchild that outlives the run.
  server = spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...PLACEHOLDER_ENV, ...process.env },
    detached: true,
  });
}

function stopServer() {
  if (server && !server.killed && server.pid) {
    try {
      // Negative pid → signal the entire process group (next + children).
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Group may already be gone; fall back to the direct child.
      try {
        server.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    }
  }
}

const specs = readdirSync(here)
  .filter((f) => f.endsWith(".spec.mjs"))
  .sort();

if (specs.length === 0) {
  log("no *.spec.mjs files found");
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
  log(`server ready, running ${specs.length} spec(s)`);

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
    log(`${failed}/${specs.length} spec(s) failed`);
    process.exit(1);
  }
  log(`all ${specs.length} spec(s) passed`);
  process.exit(0);
} catch (err) {
  console.error(err);
  stopServer();
  process.exit(1);
}
