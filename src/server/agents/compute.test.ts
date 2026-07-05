import { beforeEach, describe, expect, it } from "vitest";

import {
  getRepoCompute,
  getUserCompute,
  mergeCompute,
  resolveCompute,
} from "~/server/agents/compute";
import { type db as Database } from "~/server/db";
import { repoWebhookConfig, userCompute } from "~/server/db/schema";

// Both loaders run a single select().from().where().limit() chain; a stub that
// keys the resolved rows on the table passed to from() drives every branch
// without real drizzle/pg. The repo compute default is read off the full
// repo-config row (loadRepoConfig), hence the computeCpu/computeMemory columns.
let userRows: { cpu: string | null; memory: string | null }[] = [];
let repoRows: {
  computeCpu: string | null;
  computeMemory: string | null;
  preferRepoCredentials: boolean;
}[] = [];
const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            table === userCompute
              ? userRows
              : table === repoWebhookConfig
                ? repoRows
                : [],
          ),
      }),
    }),
  }),
} as unknown as typeof Database;

beforeEach(() => {
  userRows = [];
  repoRows = [];
});

describe("getUserCompute / getRepoCompute", () => {
  it("returns the stored rows, and null when none exist", async () => {
    await expect(getUserCompute(db, "u1")).resolves.toBeNull();
    await expect(getRepoCompute(db, "o/r")).resolves.toBeNull();

    userRows = [{ cpu: "4", memory: null }];
    repoRows = [
      { computeCpu: null, computeMemory: "8Gi", preferRepoCredentials: true },
    ];
    await expect(getUserCompute(db, "u1")).resolves.toEqual({
      cpu: "4",
      memory: null,
    });
    await expect(getRepoCompute(db, "o/r")).resolves.toEqual({
      cpu: null,
      memory: "8Gi",
      preferRepoCredentials: true,
    });
  });
});

describe("resolveCompute", () => {
  it("returns all-null when neither the user nor the repo has a default", async () => {
    await expect(resolveCompute(db, "u1", "o/r")).resolves.toEqual({
      cpu: null,
      memory: null,
    });
  });

  it("uses the user's default when the repo has none", async () => {
    userRows = [{ cpu: "4", memory: "8Gi" }];
    await expect(resolveCompute(db, "u1", "o/r")).resolves.toEqual({
      cpu: "4",
      memory: "8Gi",
    });
  });

  it("prefers the user's default over the repo's by default", async () => {
    userRows = [{ cpu: "4", memory: "8Gi" }];
    repoRows = [
      { computeCpu: "2", computeMemory: "2Gi", preferRepoCredentials: false },
    ];
    await expect(resolveCompute(db, "u1", "o/r")).resolves.toEqual({
      cpu: "4",
      memory: "8Gi",
    });
  });

  it("prefers the repo's default when its prefer flag is set", async () => {
    userRows = [{ cpu: "4", memory: "8Gi" }];
    repoRows = [
      { computeCpu: "2", computeMemory: "2Gi", preferRepoCredentials: true },
    ];
    await expect(resolveCompute(db, "u1", "o/r")).resolves.toEqual({
      cpu: "2",
      memory: "2Gi",
    });
  });

  it("resolves per field: a source missing one field falls through for just that field", async () => {
    userRows = [{ cpu: "4", memory: "8Gi" }];
    repoRows = [
      { computeCpu: null, computeMemory: "16Gi", preferRepoCredentials: true },
    ];
    await expect(resolveCompute(db, "u1", "o/r")).resolves.toEqual({
      cpu: "4",
      memory: "16Gi",
    });
  });

  it("only considers the user's default for repo-less runs", async () => {
    userRows = [{ cpu: "4", memory: null }];
    repoRows = [
      { computeCpu: "2", computeMemory: "2Gi", preferRepoCredentials: true },
    ];
    await expect(resolveCompute(db, "u1")).resolves.toEqual({
      cpu: "4",
      memory: null,
    });
  });
});

describe("mergeCompute", () => {
  it("returns undefined when nothing is set anywhere", () => {
    expect(mergeCompute({ cpu: null, memory: null })).toBeUndefined();
    expect(mergeCompute({ cpu: null, memory: null }, {})).toBeUndefined();
  });

  it("passes the defaults through when there is no override", () => {
    expect(mergeCompute({ cpu: "4", memory: null })).toEqual({
      cpu: "4",
      memory: undefined,
    });
  });

  it("lets the override win per field", () => {
    expect(
      mergeCompute({ cpu: "4", memory: "8Gi" }, { memory: "16Gi" }),
    ).toEqual({ cpu: "4", memory: "16Gi" });
  });
});
