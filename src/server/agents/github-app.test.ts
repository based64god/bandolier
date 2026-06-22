import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAppJwt,
  buildDockerConfigJson,
  clearTokenCache,
  getInstallationToken,
  getRegistryPullSecret,
  imageRegistryHost,
  isGithubAppConfigured,
} from "~/server/agents/github-app";

// Decodes a base64url segment back to a UTF-8 string.
function decodeSegment(seg: string): string {
  return Buffer.from(seg, "base64url").toString("utf8");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearTokenCache();
});

describe("isGithubAppConfigured", () => {
  it("is true when the test App id + key are present", () => {
    expect(isGithubAppConfigured()).toBe(true);
  });
});

describe("buildAppJwt", () => {
  const NOW = 1_700_000_000; // fixed epoch seconds

  it("produces a three-part JWT with an RS256 header", () => {
    const jwt = buildAppJwt(NOW);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(decodeSegment(parts[0]!)) as Record<
      string,
      unknown
    >;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("backdates iat by 60s and caps exp within GitHub's 10-minute limit", () => {
    const parts = buildAppJwt(NOW).split(".");
    const payload = JSON.parse(decodeSegment(parts[1]!)) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(payload.iat).toBe(NOW - 60);
    expect(payload.exp).toBe(NOW + 9 * 60);
    // The whole window must stay under 10 minutes from iat.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.iss).toBe("123456");
  });

  it("signs the header.payload with the App private key (verifiable by its public key)", () => {
    const jwt = buildAppJwt(NOW);
    const [h, p, sig] = jwt.split(".");
    // Derive the public key from the same private key the broker signs with.
    const pem = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");
    const publicKey = crypto.createPublicKey(pem);
    const ok = crypto
      .createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("getInstallationToken", () => {
  const NOW = 1_700_000_000_000; // fixed epoch ms

  function mockTokenFetch(token: string, expiresAt: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      json: () => Promise.resolve({ token, expires_at: expiresAt }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    clearTokenCache();
  });

  it("mints a token via the installation access_tokens endpoint", async () => {
    const fetchMock = mockTokenFetch(
      "ghs_minted",
      new Date(NOW + 60 * 60_000).toISOString(),
    );
    const token = await getInstallationToken("42", NOW);
    expect(token).toBe("ghs_minted");

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(call[1].method).toBe("POST");
    const auth = (call[1].headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer .+\..+\..+$/); // a signed App JWT
  });

  it("reuses a cached token while it is still fresh", async () => {
    const fetchMock = mockTokenFetch(
      "ghs_cached",
      new Date(NOW + 60 * 60_000).toISOString(),
    );
    await getInstallationToken("42", NOW);
    // A second call a minute later must not hit the network.
    const token = await getInstallationToken("42", NOW + 60_000);
    expect(token).toBe("ghs_cached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints when the cached token is within the refresh margin of expiry", async () => {
    const fetchMock = mockTokenFetch(
      "ghs_first",
      new Date(NOW + 60 * 60_000).toISOString(),
    );
    await getInstallationToken("42", NOW);
    // 58 minutes later the token is inside the 5-minute refresh margin.
    await getInstallationToken("42", NOW + 58 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when GitHub rejects the token exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({}),
      }),
    );
    await expect(getInstallationToken("42", NOW)).rejects.toThrow(
      /token exchange failed: 401/,
    );
  });
});

describe("imageRegistryHost", () => {
  it("extracts a registry host with a dot", () => {
    expect(imageRegistryHost("ghcr.io/acme/img:tag")).toBe("ghcr.io");
    expect(imageRegistryHost("registry.example.com/x")).toBe(
      "registry.example.com",
    );
  });

  it("extracts a registry host with a port", () => {
    expect(imageRegistryHost("registry.example.com:5000/x")).toBe(
      "registry.example.com:5000",
    );
    expect(imageRegistryHost("localhost:5000/x")).toBe("localhost:5000");
  });

  it("treats bare localhost as a registry host", () => {
    expect(imageRegistryHost("localhost/x")).toBe("localhost");
  });

  it("returns null for implicit Docker Hub references", () => {
    expect(imageRegistryHost("acme/bandolier-agent")).toBeNull();
    expect(imageRegistryHost("bandolier-agent")).toBeNull();
    expect(imageRegistryHost("library/ubuntu:22.04")).toBeNull();
  });
});

describe("buildDockerConfigJson", () => {
  it("produces a dockerconfigjson with a base64 auth for the registry", () => {
    const json = buildDockerConfigJson("ghcr.io", "bandolier", "ghs_token");
    const parsed = JSON.parse(json) as {
      auths: Record<
        string,
        { username: string; password: string; auth: string }
      >;
    };
    const entry = parsed.auths["ghcr.io"]!;
    expect(entry.username).toBe("bandolier");
    expect(entry.password).toBe("ghs_token");
    expect(Buffer.from(entry.auth, "base64").toString("utf8")).toBe(
      "bandolier:ghs_token",
    );
  });
});

describe("getRegistryPullSecret", () => {
  it("builds GHCR pull creds from the user's OAuth token", () => {
    const secret = getRegistryPullSecret(
      "ghcr.io/acme/harness:latest",
      "gho_usertoken",
    );
    expect(secret?.registry).toBe("ghcr.io");
    const parsed = JSON.parse(secret!.dockerConfigJson) as {
      auths: Record<string, { password: string }>;
    };
    // Authenticates with the user's token, never an installation token.
    expect(parsed.auths["ghcr.io"]?.password).toBe("gho_usertoken");
  });

  it("returns null for non-GHCR images even with a token", () => {
    expect(
      getRegistryPullSecret("registry.example.com/x:1", "gho_usertoken"),
    ).toBeNull();
    expect(getRegistryPullSecret("acme/img:1", "gho_usertoken")).toBeNull();
  });

  it("returns null when the user has no linked GitHub token", () => {
    expect(getRegistryPullSecret("ghcr.io/acme/img:1", null)).toBeNull();
    expect(getRegistryPullSecret("ghcr.io/acme/img:1", undefined)).toBeNull();
  });
});
