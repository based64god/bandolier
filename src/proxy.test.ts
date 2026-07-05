// Tests for the shared-password gate middleware (src/proxy.ts): the exempt-path
// list, gate-cookie verification, and the 401-vs-redirect split for
// unauthenticated requests. Uses real NextRequest objects — the gate is pure
// header/URL logic, so no network is involved — and vi.stubEnv to control
// APP_PASSWORD / BETTER_AUTH_SECRET per test.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GATE_COOKIE, gateToken } from "~/lib/gate";
import { EXEMPT_EXACT, proxy } from "~/proxy";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Walks src/app/api for every route.ts and returns the URL pathnames of those
 * that authenticate via the harness's per-job HMAC token (verifyIngestToken).
 * These MUST be gate-exempt — the in-pod harness has no session to present.
 */
function harnessCallbackPaths(): string[] {
  const apiDir = join(SRC_DIR, "app", "api");
  const paths: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...segments, entry.name]);
      } else if (entry.name === "route.ts") {
        if (readFileSync(full, "utf8").includes("verifyIngestToken")) {
          paths.push(`/api/${segments.join("/")}`);
        }
      }
    }
  };
  walk(apiDir, []);
  return paths;
}

const PASSWORD = "pw";
// The placeholder secret vitest.config.ts injects for every test.
const SECRET = "test-secret";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://bandolier.test${path}`, {
    headers: cookie ? { cookie: `${GATE_COOKIE}=${cookie}` } : {},
  });
}

/** NextResponse.next() marks a pass-through with this middleware header. */
function isPassThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("passes everything through when no APP_PASSWORD is configured", async () => {
    vi.stubEnv("APP_PASSWORD", undefined);
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(200);
    expect(isPassThrough(res)).toBe(true);
  });

  describe("exempt paths (no cookie required)", () => {
    it.each(["/api/webhooks/github", "/api/v1/runs"])(
      "lets the prefix-exempt path %s through",
      async (path) => {
        vi.stubEnv("APP_PASSWORD", PASSWORD);
        const res = await proxy(request(path));
        expect(isPassThrough(res)).toBe(true);
      },
    );

    it.each([
      "/api/agent-runs",
      "/api/agent-input",
      "/api/acp",
      "/api/version",
      "/api/health",
      "/setup.sh",
      "/gate",
      "/api/gate",
      "/icon.svg",
      "/apple-icon",
      "/opengraph-image",
      "/favicon.ico",
      "/manifest.webmanifest",
      "/sw.js",
      "/icon-192.png",
      "/icon-512.png",
    ])("lets the exact-exempt path %s through", async (path) => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request(path));
      expect(isPassThrough(res)).toBe(true);
    });

    // The security boundary: exact-match exemptions must not behave as
    // prefixes, or /api/agent-runs/<anything> would slip past the gate.
    it.each([
      "/api/agent-runs/x",
      "/api/versionX",
      "/api/acp/relay",
      "/api/healthz",
    ])("does NOT exempt the near-miss API path %s", async (path) => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request(path));
      expect(res.status).toBe(401);
    });

    it("does NOT exempt the near-miss page path /gate2", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request("/gate2"));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/gate");
    });

    // Guards the recurring failure mode: a new harness-callback route that
    // forgets to add itself to EXEMPT_EXACT silently 401s behind the gate.
    // Every route authenticating via the per-job HMAC token must be exempt.
    it("exempts every harness-callback route (verifyIngestToken)", () => {
      const callbacks = harnessCallbackPaths();
      // Sanity check that discovery actually found the known callbacks.
      expect(callbacks).toEqual(
        expect.arrayContaining([
          "/api/agent-runs",
          "/api/agent-input",
          "/api/acp",
        ]),
      );
      for (const path of callbacks) {
        expect(EXEMPT_EXACT.has(path)).toBe(true);
      }
    });
  });

  describe("gate cookie verification", () => {
    it("accepts the derived gate token on a non-exempt path", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const token = await gateToken(PASSWORD, SECRET);
      const res = await proxy(request("/dashboard", token));
      expect(res.status).toBe(200);
      expect(isPassThrough(res)).toBe(true);
    });

    it("rejects a same-length token derived from the wrong password", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const forged = await gateToken("other", SECRET);
      const res = await proxy(request("/api/trpc/x", forged));
      expect(res.status).toBe(401);
    });

    it("rejects a short garbage cookie without throwing (length mismatch)", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request("/dashboard", "deadbeef"));
      expect(res.status).toBe(307);
    });

    it("still verifies when BETTER_AUTH_SECRET is unset (empty-string salt)", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      vi.stubEnv("BETTER_AUTH_SECRET", undefined);
      const token = await gateToken(PASSWORD, "");
      const res = await proxy(request("/dashboard", token));
      expect(isPassThrough(res)).toBe(true);
    });
  });

  describe("unauthenticated requests", () => {
    it("answers API paths with a JSON 401 instead of a redirect", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request("/api/trpc/agents.list"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Password required" });
    });

    it("redirects page navigations to /gate with ?from=<pathname>", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request("/dashboard"));
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/gate");
      expect(location.searchParams.get("from")).toBe("/dashboard");
    });

    it("strips the original query string from the gate redirect", async () => {
      vi.stubEnv("APP_PASSWORD", PASSWORD);
      const res = await proxy(request("/dashboard?tab=x&y=1"));
      const location = new URL(res.headers.get("location")!);
      // Only the from marker survives; the original query is dropped.
      expect([...location.searchParams.keys()]).toEqual(["from"]);
      expect(location.searchParams.get("from")).toBe("/dashboard");
    });
  });
});
