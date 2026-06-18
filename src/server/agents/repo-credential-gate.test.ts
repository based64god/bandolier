import { beforeEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";
import type { ModelCredentials } from "~/server/agents/resolve-credentials";

// Drive the gate by stubbing the two resolvers it composes.
const resolveModelCredentials = vi.fn<() => Promise<ModelCredentials>>();
const resolveKubeconfigWithSource =
  vi.fn<() => Promise<{ kubeconfig: string | null; source: string }>>();

vi.mock("~/server/agents/resolve-credentials", () => ({
  resolveModelCredentials: () => resolveModelCredentials(),
}));
vi.mock("~/server/agents/kubeconfig", () => ({
  resolveKubeconfigWithSource: () => resolveKubeconfigWithSource(),
}));

const { usesRepoCredentials } =
  await import("~/server/agents/repo-credential-gate");

const db = {} as unknown as typeof Database;

function creds(source: ModelCredentials["source"]): ModelCredentials {
  return {
    aws: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    geminiApiKey: null,
    source,
  };
}

beforeEach(() => {
  resolveModelCredentials.mockReset().mockResolvedValue(creds("user"));
  resolveKubeconfigWithSource
    .mockReset()
    .mockResolvedValue({ kubeconfig: "kc", source: "user" });
});

describe("usesRepoCredentials", () => {
  it("is false for a repo-less context (and never queries credentials)", async () => {
    expect(await usesRepoCredentials(db, "u1")).toBe(false);
    expect(resolveModelCredentials).not.toHaveBeenCalled();
    expect(resolveKubeconfigWithSource).not.toHaveBeenCalled();
  });

  it("is false when both model creds and kubeconfig are the user's own", async () => {
    expect(await usesRepoCredentials(db, "u1", "o/r")).toBe(false);
  });

  it("is true when the repo's shared model credentials win", async () => {
    resolveModelCredentials.mockResolvedValue(creds("repo"));
    expect(await usesRepoCredentials(db, "u1", "o/r")).toBe(true);
  });

  it("is true when only the kubeconfig is the repo's shared cluster", async () => {
    resolveKubeconfigWithSource.mockResolvedValue({
      kubeconfig: "kc",
      source: "repo",
    });
    expect(await usesRepoCredentials(db, "u1", "o/r")).toBe(true);
  });
});
