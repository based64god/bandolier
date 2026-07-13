import { describe, expect, it } from "vitest";

import type { db } from "~/server/db";
import { getUserAwsCredentials } from "~/server/agents/user-aws";

/**
 * Fakes the drizzle select().from().where().limit() chain, resolving to the
 * given rows. Only the null branch and the field projection are pinned here —
 * the WHERE filter is a drizzle SQL AST and too brittle to compare.
 */
function fakeDb(rows: unknown[]): typeof db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  } as unknown as typeof db;
}

describe("getUserAwsCredentials", () => {
  const row = {
    userId: "u1",
    accessKeyId: "AKIA1",
    secretAccessKey: "sec",
    sessionToken: "tok",
    region: "us-east-1",
    createdAt: new Date(),
  };

  it("returns null when the user has no stored credentials", async () => {
    expect(await getUserAwsCredentials(fakeDb([]), "u1")).toBeNull();
  });

  it("projects the row down to exactly the credential fields", async () => {
    // Non-credential columns (userId, createdAt) must not leak into the
    // credentials object handed to job manifests.
    expect(await getUserAwsCredentials(fakeDb([row]), "u1")).toEqual({
      accessKeyId: "AKIA1",
      secretAccessKey: "sec",
      sessionToken: "tok",
      region: "us-east-1",
    });
  });

  it("passes a null session token through for downstream cleanSessionToken", async () => {
    const creds = await getUserAwsCredentials(
      fakeDb([{ ...row, sessionToken: null }]),
      "u1",
    );
    expect(creds?.sessionToken).toBeNull();
  });
});
