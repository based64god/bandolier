import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoCredentials } from "~/server/agents/webhook-config";
import type { db as Database } from "~/server/db";

// validateKubeconfig composes the k8s-client helpers with a DNS-based SSRF
// guard; mock those boundaries (and dns.lookup) so every branch — parse
// failure, unsupported auth, metadata-address rejection, probe outcome — is
// drivable without touching the network.
const getCode = vi.fn<() => Promise<{ gitVersion: string }>>();
const getVersionApi = vi.fn<(kc: string) => { getCode: typeof getCode }>();
const unsupportedKubeconfigAuth = vi.fn<(kc: string) => string | null>();
const getKubeconfigServer = vi.fn<(kc: string) => string | null>();

vi.mock("~/server/k8s/client", () => ({
  getVersionApi: (kc: string) => getVersionApi(kc),
  unsupportedKubeconfigAuth: (kc: string) => unsupportedKubeconfigAuth(kc),
  getKubeconfigServer: (kc: string) => getKubeconfigServer(kc),
}));

const lookup =
  vi.fn<
    (
      host: string,
      opts: { all: true },
    ) => Promise<{ address: string; family: number }[]>
  >();
vi.mock("node:dns/promises", () => ({
  lookup: (host: string, opts: { all: true }) => lookup(host, opts),
}));

const getRepoCredentials = vi.fn<() => Promise<RepoCredentials | null>>();
vi.mock("~/server/agents/webhook-config", () => ({
  getRepoCredentials: () => getRepoCredentials(),
}));

const { getUserKubeconfig, resolveKubeconfig, validateKubeconfig } =
  await import("~/server/agents/kubeconfig");

// getUserKubeconfig runs a single select().from().where().limit() chain, so a
// stub resolving the per-test rows suffices — no real drizzle/pg involved.
let kubeconfigRows: { kubeconfig: string | null }[] = [];
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(kubeconfigRows),
      }),
    }),
  }),
} as unknown as typeof Database;

function repo(overrides: Partial<RepoCredentials>): RepoCredentials {
  return {
    kubeconfig: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    geminiApiKey: null,
    aws: null,
    preferRepoCredentials: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kubeconfigRows = [];
  getVersionApi.mockReturnValue({ getCode });
  getCode.mockResolvedValue({ gitVersion: "v1.31.0" });
  unsupportedKubeconfigAuth.mockReturnValue(null);
  getKubeconfigServer.mockReturnValue(null);
  getRepoCredentials.mockResolvedValue(null);
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("validateKubeconfig", () => {
  it("reports the probe's server version when everything checks out", async () => {
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: true,
      version: "v1.31.0",
    });
    // No server URL to guard, so DNS was never consulted.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps a parse failure to an Invalid kubeconfig error", async () => {
    getVersionApi.mockImplementation(() => {
      throw new Error("bad yaml");
    });
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error: "Invalid kubeconfig: bad yaml",
    });
  });

  it("falls back to a generic message when the parse throws a non-Error", async () => {
    getVersionApi.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error catch branch
      throw "boom";
    });
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error: "Invalid kubeconfig.",
    });
  });

  it("rejects unsupported auth with the reason and the setup.sh hint, without probing", async () => {
    unsupportedKubeconfigAuth.mockReturnValue(
      "the selected context authenticates with an exec credential plugin",
    );
    const result = await validateKubeconfig("kc");
    expect(result.valid).toBe(false);
    expect(result.error).toContain(
      "the selected context authenticates with an exec credential plugin",
    );
    // env.BETTER_AUTH_URL defaults to localhost in the test environment.
    expect(result.error).toContain(
      "curl -fsSL http://localhost:3000/setup.sh | bash",
    );
    expect(getCode).not.toHaveBeenCalled();
  });

  it("blocks a server that is a link-local IPv4 literal (metadata endpoint)", async () => {
    getKubeconfigServer.mockReturnValue("https://169.254.169.254:443");
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error:
        "Invalid kubeconfig: cluster server points at a link-local/metadata address",
    });
    expect(getCode).not.toHaveBeenCalled();
    // An IP literal short-circuits the DNS resolution step.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("misses an IPv4-mapped IPv6 metadata literal in the URL (suspected gap)", async () => {
    // SUSPECTED SOURCE BUG, pinned: WHATWG URL canonicalizes
    // [::ffff:169.254.169.254] to the hex form [::ffff:a9fe:a9fe], which the
    // dotted-quad regex in isMetadataAddress doesn't match — so this literal
    // slips past the SSRF guard and the probe runs. The dotted form the regex
    // does catch can only arrive via the DNS-lookup path (next test).
    getKubeconfigServer.mockReturnValue(
      "https://[::ffff:169.254.169.254]:6443",
    );
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: true,
      version: "v1.31.0",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("blocks a DNS name resolving to an IPv4-mapped IPv6 metadata address", async () => {
    getKubeconfigServer.mockReturnValue("https://metadata.internal:443");
    lookup.mockResolvedValue([
      { address: "::ffff:169.254.169.254", family: 6 },
    ]);
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error:
        "Invalid kubeconfig: cluster server resolves to a link-local/metadata address",
    });
    expect(getCode).not.toHaveBeenCalled();
  });

  it("blocks an IPv6 link-local literal", async () => {
    getKubeconfigServer.mockReturnValue("https://[fe80::1]:6443");
    const result = await validateKubeconfig("kc");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("points at a link-local/metadata address");
  });

  it("blocks a DNS name that resolves to a metadata address", async () => {
    getKubeconfigServer.mockReturnValue("https://metadata.internal:443");
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error:
        "Invalid kubeconfig: cluster server resolves to a link-local/metadata address",
    });
    expect(lookup).toHaveBeenCalledWith("metadata.internal", { all: true });
    expect(getCode).not.toHaveBeenCalled();
  });

  it("deliberately allows other private ranges (on-prem / kind clusters)", async () => {
    getKubeconfigServer.mockReturnValue("https://10.0.0.5:6443");
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: true,
      version: "v1.31.0",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("leaves an unresolvable host to the probe, which reports unreachable", async () => {
    getKubeconfigServer.mockReturnValue("https://nope.example:6443");
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    getCode.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error: "connect ECONNREFUSED",
    });
  });

  it("lets the probe decide when the server URL is malformed", async () => {
    getKubeconfigServer.mockReturnValue("not a url");
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: true,
      version: "v1.31.0",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the probe rejects with a non-Error", async () => {
    getCode.mockRejectedValue("weird");
    await expect(validateKubeconfig("kc")).resolves.toEqual({
      valid: false,
      error: "Could not reach the cluster.",
    });
  });
});

describe("getUserKubeconfig", () => {
  it("returns the stored kubeconfig when a row exists", async () => {
    kubeconfigRows = [{ kubeconfig: "kc-yaml" }];
    await expect(getUserKubeconfig(db, "u1")).resolves.toBe("kc-yaml");
  });

  it("returns null when the user has no row", async () => {
    kubeconfigRows = [];
    await expect(getUserKubeconfig(db, "u1")).resolves.toBeNull();
  });
});

describe("resolveKubeconfig", () => {
  it("uses the user's kubeconfig when the repo has no config", async () => {
    kubeconfigRows = [{ kubeconfig: "user-kc" }];
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBe("user-kc");
  });

  it("falls back to the repo's kubeconfig when the user has none", async () => {
    getRepoCredentials.mockResolvedValue(repo({ kubeconfig: "repo-kc" }));
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBe("repo-kc");
  });

  it("prefers the user's kubeconfig over the repo's by default", async () => {
    kubeconfigRows = [{ kubeconfig: "user-kc" }];
    getRepoCredentials.mockResolvedValue(repo({ kubeconfig: "repo-kc" }));
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBe("user-kc");
  });

  it("prefers the repo's kubeconfig when the repo flag is set", async () => {
    kubeconfigRows = [{ kubeconfig: "user-kc" }];
    getRepoCredentials.mockResolvedValue(
      repo({ kubeconfig: "repo-kc", preferRepoCredentials: true }),
    );
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBe("repo-kc");
  });

  it("falls back to the user's kubeconfig when the preferred repo has none", async () => {
    kubeconfigRows = [{ kubeconfig: "user-kc" }];
    getRepoCredentials.mockResolvedValue(repo({ preferRepoCredentials: true }));
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBe("user-kc");
  });

  it("returns null when neither the user nor the repo has one", async () => {
    getRepoCredentials.mockResolvedValue(repo({}));
    await expect(resolveKubeconfig(db, "u1", "o/r")).resolves.toBeNull();
  });

  it("skips the repo lookup entirely when no repo is given", async () => {
    kubeconfigRows = [{ kubeconfig: "user-kc" }];
    await expect(resolveKubeconfig(db, "u1")).resolves.toBe("user-kc");
    expect(getRepoCredentials).not.toHaveBeenCalled();
  });
});
