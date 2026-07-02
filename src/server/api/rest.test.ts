import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import {
  errorMessage,
  statusForTrpcError,
  toTaskResource,
} from "~/server/api/rest";

describe("statusForTrpcError", () => {
  it.each([
    ["NOT_FOUND", 404],
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
  ] as const)("maps %s to %i", (code, status) => {
    expect(statusForTrpcError(new TRPCError({ code }))).toBe(status);
  });

  it("maps other tRPC error codes to 500", () => {
    expect(
      statusForTrpcError(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
    ).toBe(500);
  });

  it("maps non-tRPC errors to 500", () => {
    expect(statusForTrpcError(new Error("boom"))).toBe(500);
    expect(statusForTrpcError("not an error")).toBe(500);
  });
});

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns a generic message for non-Error values", () => {
    expect(errorMessage("a string")).toBe("Internal error");
    expect(errorMessage(undefined)).toBe("Internal error");
  });
});

describe("toTaskResource", () => {
  const internal = {
    name: "pod-abc",
    jobName: "job-abc",
    repoFullName: "owner/repo",
    displayName: "Fix bug",
    prompt: "do the thing",
    source: "dashboard",
    issueNumber: "12",
    issueUrl: "https://github.com/owner/repo/issues/12",
    createdBy: "octocat",
    status: "Running",
    currently: "thinking",
    expiresAt: "2026-01-01T00:00:00Z",
    pullRequestUrl: "https://github.com/owner/repo/pull/13",
  };

  it("renames jobName to id and name to podName", () => {
    const resource = toTaskResource(internal);
    expect(resource.id).toBe("job-abc");
    expect(resource.podName).toBe("pod-abc");
  });

  it("renames repoFullName to repo", () => {
    expect(toTaskResource(internal).repo).toBe("owner/repo");
  });

  it("carries through the public fields verbatim", () => {
    const resource = toTaskResource(internal);
    expect(resource).toMatchObject({
      displayName: "Fix bug",
      prompt: "do the thing",
      source: "dashboard",
      issueNumber: "12",
      issueUrl: "https://github.com/owner/repo/issues/12",
      createdBy: "octocat",
      status: "Running",
      currently: "thinking",
      pullRequestUrl: "https://github.com/owner/repo/pull/13",
      expiresAt: "2026-01-01T00:00:00Z",
    });
  });

  it("does not leak internal-only keys", () => {
    const resource = toTaskResource(internal);
    expect(resource).not.toHaveProperty("name");
    expect(resource).not.toHaveProperty("jobName");
    expect(resource).not.toHaveProperty("repoFullName");
  });

  it("reports null tokens when the run has no usage", () => {
    expect(toTaskResource(internal).tokens).toBeNull();
    expect(toTaskResource({ ...internal, tokens: null }).tokens).toBeNull();
  });

  it("exposes the token breakdown plus a computed total", () => {
    const resource = toTaskResource({
      ...internal,
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
      },
    });
    expect(resource.tokens).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      totalTokens: 165,
    });
  });
});
