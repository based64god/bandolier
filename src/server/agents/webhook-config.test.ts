import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import { repoWebhookConfig } from "~/server/db/schema";
import {
  getRepoCredentials,
  getRepoWebhookConfig,
  isRepoAdmin,
} from "~/server/agents/webhook-config";

// Per-repo webhook config loaders over a faked drizzle select chain, plus the
// isRepoAdmin gate (fetch stubbed) that fronts all the admin-only config.

/** select().from().where().limit() resolves `rows` — every loader's shape. */
function makeSelectDb(rows: Record<string, unknown>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { database: { select } as unknown as typeof Database, where };
}

/** A getRepoCredentials row with nothing configured; tests spread overrides. */
function credsRow(overrides: Record<string, unknown> = {}) {
  return {
    kubeconfig: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    geminiApiKey: null,
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
    awsSessionToken: null,
    awsRegion: null,
    preferRepoCredentials: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getRepoCredentials", () => {
  it("returns null when the repo has no config row", async () => {
    const { database, where } = makeSelectDb([]);
    expect(await getRepoCredentials(database, "o/r")).toBeNull();
    expect(where).toHaveBeenCalledWith(
      eq(repoWebhookConfig.repoFullName, "o/r"),
    );
  });

  it("assembles a complete AWS set and passes the other fields through", async () => {
    const { database } = makeSelectDb([
      credsRow({
        kubeconfig: "kc-yaml",
        anthropicApiKey: "sk-ant",
        openaiApiKey: "sk-oai",
        geminiApiKey: "sk-gem",
        awsAccessKeyId: "AKIAREPO",
        awsSecretAccessKey: "repo-secret",
        awsSessionToken: "repo-session",
        awsRegion: "eu-west-1",
        preferRepoCredentials: true,
      }),
    ]);
    expect(await getRepoCredentials(database, "o/r")).toEqual({
      kubeconfig: "kc-yaml",
      anthropicApiKey: "sk-ant",
      openaiApiKey: "sk-oai",
      geminiApiKey: "sk-gem",
      aws: {
        accessKeyId: "AKIAREPO",
        secretAccessKey: "repo-secret",
        sessionToken: "repo-session",
        region: "eu-west-1",
      },
      preferRepoCredentials: true,
    });
  });

  it("discards an AWS key id without its secret — creds only count as a pair", async () => {
    const { database } = makeSelectDb([
      credsRow({ awsAccessKeyId: "AKIAREPO" }),
    ]);
    const creds = await getRepoCredentials(database, "o/r");
    expect(creds?.aws).toBeNull();
  });

  it("discards an AWS secret without its key id", async () => {
    const { database } = makeSelectDb([
      credsRow({ awsSecretAccessKey: "repo-secret" }),
    ]);
    const creds = await getRepoCredentials(database, "o/r");
    expect(creds?.aws).toBeNull();
  });

  it("defaults a complete AWS pair without a region to us-east-1", async () => {
    const { database } = makeSelectDb([
      credsRow({
        awsAccessKeyId: "AKIAREPO",
        awsSecretAccessKey: "repo-secret",
      }),
    ]);
    const creds = await getRepoCredentials(database, "o/r");
    expect(creds?.aws).toEqual({
      accessKeyId: "AKIAREPO",
      secretAccessKey: "repo-secret",
      sessionToken: null,
      region: "us-east-1",
    });
  });
});

describe("getRepoWebhookConfig", () => {
  it("returns null when the repo has no config row", async () => {
    const { database } = makeSelectDb([]);
    expect(await getRepoWebhookConfig(database, "o/r")).toBeNull();
  });

  it("maps the flat row into the nested config shape", async () => {
    const { database } = makeSelectDb([
      {
        prefix: "/bando",
        agentImage: "ghcr.io/x/harness:1",
        defaultWebhookModel: "claude-sonnet-4-5",
        defaultWebhookEffort: "high",
        systemPrompt: "be terse",
        resumeOnCiFailure: true,
        autoMergeBandolierPrs: true,
        allowPrivateEgress: true,
        allowAllPortsEgress: false,
        networkPolicyYaml: "kind: NetworkPolicy",
      },
    ]);
    expect(await getRepoWebhookConfig(database, "o/r")).toEqual({
      prefix: "/bando",
      agentImage: "ghcr.io/x/harness:1",
      defaultWebhookModel: "claude-sonnet-4-5",
      defaultWebhookEffort: "high",
      systemPrompt: "be terse",
      resumeOnCiFailure: true,
      autoMergeBandolierPrs: true,
      networkPolicy: {
        allowPrivateEgress: true,
        allowAllPortsEgress: false,
        policyYaml: "kind: NetworkPolicy",
      },
    });
  });

  it("maps an all-defaults row to nulls and off toggles", async () => {
    const { database } = makeSelectDb([
      {
        prefix: null,
        agentImage: null,
        defaultWebhookModel: null,
        defaultWebhookEffort: null,
        systemPrompt: null,
        resumeOnCiFailure: false,
        autoMergeBandolierPrs: false,
        allowPrivateEgress: false,
        allowAllPortsEgress: false,
        networkPolicyYaml: null,
      },
    ]);
    expect(await getRepoWebhookConfig(database, "o/r")).toEqual({
      prefix: null,
      agentImage: null,
      defaultWebhookModel: null,
      defaultWebhookEffort: null,
      systemPrompt: null,
      resumeOnCiFailure: false,
      autoMergeBandolierPrs: false,
      networkPolicy: {
        allowPrivateEgress: false,
        allowAllPortsEgress: false,
        policyYaml: null,
      },
    });
  });
});

describe("isRepoAdmin", () => {
  function mockFetchOnce(body: unknown, ok = true, status = 200) {
    const json = vi.fn(() => Promise.resolve(body));
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json,
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, json };
  }

  it("is true for an admin, asking GitHub with the user's token", async () => {
    const { fetchMock } = mockFetchOnce({ permissions: { admin: true } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/o/r", {
      headers: {
        Authorization: "Bearer tok",
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  });

  it("is false when admin is false", async () => {
    mockFetchOnce({ permissions: { admin: false } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("is false when the body has no permissions at all", async () => {
    mockFetchOnce({});
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("is false when admin is truthy but not boolean true", async () => {
    mockFetchOnce({ permissions: { admin: 1 } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("fails closed on an API error without reading the body", async () => {
    const { json } = mockFetchOnce({}, false, 404);
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("fails closed when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("fails closed when the body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(new Error("malformed body")),
      }),
    );
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });
});
