import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import {
  getUserGeminiKey,
  listGeminiModels,
  mintGoogleAccessToken,
  parseGoogleCredentials,
  summarizeGeminiCredentials,
  validateGeminiCredentials,
} from "~/server/agents/gemini";

const validServiceAccount = JSON.stringify({
  type: "service_account",
  project_id: "my-project",
  client_email: "agent@my-project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIstub\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
});

// A real throwaway RSA keypair so the JWT-signing path can run (and the
// signature be verified) without touching Google. Generated once per run.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// A structurally valid service account whose private key actually signs.
const signingAccount = {
  type: "service_account",
  project_id: "my-project",
  client_email: "agent@my-project.iam.gserviceaccount.com",
  private_key: privateKeyPem,
};

// Decodes a base64url JWT segment back to a UTF-8 string.
function decodeSegment(seg: string): string {
  return Buffer.from(seg, "base64url").toString("utf8");
}

// Minimal duck-typed drizzle select chain: resolves `rows` for any query.
function fakeDb(rows: { apiKey: string }[]): typeof Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  } as unknown as typeof Database;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseGoogleCredentials", () => {
  it("accepts a well-formed service-account key", () => {
    const { creds, error } = parseGoogleCredentials(validServiceAccount);
    expect(error).toBeUndefined();
    expect(creds?.project_id).toBe("my-project");
  });

  it("rejects non-JSON (e.g. a pasted API key)", () => {
    const { creds, error } = parseGoogleCredentials("AIzaSyExampleApiKey");
    expect(creds).toBeUndefined();
    expect(error).toMatch(/JSON/i);
  });

  it("rejects a JSON object that isn't a service-account key", () => {
    const { error } = parseGoogleCredentials(
      JSON.stringify({ type: "authorized_user", project_id: "p" }),
    );
    expect(error).toMatch(/service-account/i);
  });

  it("lists the fields a service-account key is missing", () => {
    const { error } = parseGoogleCredentials(
      JSON.stringify({ type: "service_account", project_id: "p" }),
    );
    expect(error).toContain("client_email");
    expect(error).toContain("private_key");
  });
});

describe("summarizeGeminiCredentials", () => {
  it("extracts the project and service-account email, never the key", () => {
    const summary = summarizeGeminiCredentials(validServiceAccount);
    expect(summary).toEqual({
      projectId: "my-project",
      clientEmail: "agent@my-project.iam.gserviceaccount.com",
    });
  });

  it("returns nulls for an unparseable value", () => {
    expect(summarizeGeminiCredentials("not json")).toEqual({
      projectId: null,
      clientEmail: null,
    });
  });
});

describe("mintGoogleAccessToken", () => {
  function mockTokenFetch(response: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("exchanges a signed JWT at the default token endpoint", async () => {
    const fetchMock = mockTokenFetch({
      ok: true,
      json: () => Promise.resolve({ access_token: "tok" }),
    });
    // No token_uri in the creds — the default Google endpoint must be used.
    await expect(mintGoogleAccessToken(signingAccount)).resolves.toBe("tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("honors a custom token_uri as both endpoint and JWT audience", async () => {
    const fetchMock = mockTokenFetch({
      ok: true,
      json: () => Promise.resolve({ access_token: "tok" }),
    });
    await mintGoogleAccessToken({
      ...signingAccount,
      token_uri: "https://example.test/token",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/token");
    const assertion = (init.body as URLSearchParams).get("assertion")!;
    const claims = JSON.parse(decodeSegment(assertion.split(".")[1]!)) as {
      aud: string;
    };
    expect(claims.aud).toBe("https://example.test/token");
  });

  it("signs a verifiable RS256 jwt-bearer assertion", async () => {
    const fetchMock = mockTokenFetch({
      ok: true,
      json: () => Promise.resolve({ access_token: "tok" }),
    });
    await mintGoogleAccessToken(signingAccount);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );

    const [h, p, sig] = body.get("assertion")!.split(".");
    expect(JSON.parse(decodeSegment(h!))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(decodeSegment(p!)) as {
      iss: string;
      scope: string;
      aud: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe(signingAccount.client_email);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.exp).toBe(claims.iat + 3600);
    // The signature must verify against the keypair's public key.
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });

  it("reports a failed exchange with the status and a 200-char detail cap", async () => {
    const detail = `invalid_grant: ${"x".repeat(300)}`;
    mockTokenFetch({
      ok: false,
      status: 400,
      text: () => Promise.resolve(detail),
    });
    const err = (await mintGoogleAccessToken(signingAccount).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    // Exact match pins the truncation: only the first 200 chars survive.
    expect(err.message).toBe(
      `Token exchange failed (400). ${detail.slice(0, 200)}`,
    );
  });

  it("falls back to a bare status message when the error body is unreadable", async () => {
    mockTokenFetch({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("read fail")),
    });
    const err = (await mintGoogleAccessToken(signingAccount).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toBe("Token exchange failed (500).");
  });

  it("rejects a 200 response with no access_token", async () => {
    mockTokenFetch({ ok: true, json: () => Promise.resolve({}) });
    await expect(mintGoogleAccessToken(signingAccount)).rejects.toThrow(
      "Token endpoint returned no access_token.",
    );
  });
});

describe("validateGeminiCredentials", () => {
  it("fails structurally invalid credentials without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await validateGeminiCredentials("not json");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/JSON/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is valid when a live token mint succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "tok" }),
      }),
    );
    await expect(
      validateGeminiCredentials(JSON.stringify(signingAccount)),
    ).resolves.toEqual({ valid: true });
  });

  it("surfaces the mint failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve(""),
      }),
    );
    const r = await validateGeminiCredentials(JSON.stringify(signingAccount));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain("Token exchange failed (403)");
  });

  it("uses a generic message for non-Error failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));
    await expect(
      validateGeminiCredentials(JSON.stringify(signingAccount)),
    ).resolves.toEqual({
      valid: false,
      error: "Could not verify the credentials.",
    });
  });
});

describe("getUserGeminiKey", () => {
  it("returns the stored credentials JSON", async () => {
    const db = fakeDb([{ apiKey: '{"type":"service_account"}' }]);
    await expect(getUserGeminiKey(db, "user-1")).resolves.toBe(
      '{"type":"service_account"}',
    );
  });

  it("returns null when the user has no stored credentials", async () => {
    await expect(getUserGeminiKey(fakeDb([]), "user-1")).resolves.toBeNull();
  });
});

describe("listGeminiModels", () => {
  // Stubs fetch to satisfy the token mint and answer the models call (any
  // non-token URL) with `modelsResponse`.
  function mockModelsFetch(modelsResponse: unknown) {
    const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) =>
      String(url).startsWith("https://oauth2.googleapis.com/token")
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ access_token: "tok" }),
          })
        : Promise.resolve(modelsResponse),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("rejects invalid credentials without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listGeminiModels("not json")).rejects.toThrow(/JSON/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists chat-capable gemini models with bare ids, sorted by label", async () => {
    const fetchMock = mockModelsFetch({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              supportedGenerationMethods: ["generateContent"],
            },
            // No displayName — the bare id becomes the label.
            {
              name: "models/gemini-2.0-flash",
              supportedGenerationMethods: ["generateContent"],
            },
            // Gemini family but not chat-capable — dropped.
            {
              name: "models/gemini-embedding-001",
              supportedGenerationMethods: ["embedContent"],
            },
            // Chat-capable but not a gemini model — dropped.
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
    });

    const models = await listGeminiModels(JSON.stringify(signingAccount));
    // "Gemini 2.5 Pro" sorts before "gemini-2.0-flash": label order, not id
    // order (ids would put 2.0-flash first).
    expect(models).toEqual([
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.0-flash", label: "gemini-2.0-flash" },
    ]);

    // Second call is the models request: paged and bearer-authenticated.
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });

  it("maps a models-endpoint failure to a status message", async () => {
    mockModelsFetch({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(
      listGeminiModels(JSON.stringify(signingAccount)),
    ).rejects.toThrow("Gemini API 403: Forbidden");
  });

  it("returns an empty list when the response has no models field", async () => {
    mockModelsFetch({ ok: true, json: () => Promise.resolve({}) });
    await expect(
      listGeminiModels(JSON.stringify(signingAccount)),
    ).resolves.toEqual([]);
  });
});
