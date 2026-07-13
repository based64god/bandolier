import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { clusterDeployRouter } from "~/server/api/routers/cluster-deploy";
import { createCallerFactory } from "~/server/api/trpc";
import { clusterDeployment, userKubeconfig } from "~/server/db/schema";
import { db, resetDb, testCtx } from "~/test/integration/harness";
import { seedClusterDeployment, seedUser } from "~/test/integration/seed";

const createCaller = createCallerFactory(clusterDeployRouter);
const caller = (user: { id: string }) => createCaller(testCtx(user));

// Zero-external-stub coverage of the ownership boundary and status-gated secret
// redaction that a fakeDb cannot exercise: the cross-user query in
// ownedDeployment, and toClientDeployment only exposing secrets when status is
// "done". tick/cancel/start (which call DigitalOcean) are out of scope here.
describe("cluster-deploy ownership + redaction (real Postgres)", () => {
  beforeEach(resetDb);

  it("redacts secrets until status is done, then exposes them", async () => {
    const u = await seedUser();

    // Non-terminal: secrets are withheld even though the columns hold values.
    await seedClusterDeployment(u.id, {
      status: "bootstrapping-kubeconfig",
      spacesSecretAccessKey: "SECRET-KEY",
      kubeconfig: "KUBECONFIG",
    });
    const inProgress = await caller(u).status();
    expect(inProgress?.status).toBe("bootstrapping-kubeconfig");
    expect(inProgress?.spacesSecretAccessKey).toBeNull();
    expect(inProgress?.kubeconfig).toBeNull();
  });

  it("exposes the key + kubeconfig only on a done deployment", async () => {
    const u = await seedUser();
    await seedClusterDeployment(u.id, {
      status: "done",
      spacesSecretAccessKey: "SECRET-KEY",
      spacesAccessKeyId: "AKID",
      kubeconfig: "KUBECONFIG",
    });
    const done = await caller(u).status();
    expect(done?.status).toBe("done");
    expect(done?.spacesSecretAccessKey).toBe("SECRET-KEY");
    expect(done?.kubeconfig).toBe("KUBECONFIG");
  });

  it("status() picks the latest by createdAt and hides dismissed ones", async () => {
    const u = await seedUser();
    await seedClusterDeployment(u.id, {
      status: "failed",
      createdAt: new Date(Date.now() - 10_000),
    });
    // A newer, dismissed deployment → status() returns null (nothing to show).
    await seedClusterDeployment(u.id, {
      status: "dismissed",
      createdAt: new Date(Date.now() - 1_000),
    });
    expect(await caller(u).status()).toBeNull();
  });

  it("enforces the cross-user ownership boundary with NOT_FOUND", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const dep = await seedClusterDeployment(owner.id, {
      status: "done",
      kubeconfig: "KC",
    });

    // Another user cannot dismiss or save from someone else's deployment.
    await expect(
      caller(other).dismiss({ id: dep.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(other).saveKubeconfig({ id: dep.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The owner still can.
    await expect(
      caller(owner).dismiss({ id: dep.id }),
    ).resolves.toBeTruthy();
  });

  it("saveKubeconfig upserts the user's kubeconfig, and requires status done", async () => {
    const u = await seedUser();

    // Not done → PRECONDITION_FAILED, nothing written.
    const pending = await seedClusterDeployment(u.id, {
      status: "saving",
      kubeconfig: "KC-PENDING",
    });
    await expect(
      caller(u).saveKubeconfig({ id: pending.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db
        .select()
        .from(userKubeconfig)
        .where(eq(userKubeconfig.userId, u.id)),
    ).toHaveLength(0);

    // Done → upsert into user_kubeconfig.
    const done = await seedClusterDeployment(u.id, {
      status: "done",
      kubeconfig: "KC-FINAL",
      createdAt: new Date(),
    });
    const res = await caller(u).saveKubeconfig({
      id: done.id,
    });
    expect(res).toEqual({ success: true });
    const [kc] = await db
      .select()
      .from(userKubeconfig)
      .where(eq(userKubeconfig.userId, u.id));
    expect(kc!.kubeconfig).toBe("KC-FINAL");
  });

  it("dismiss wipes remaining secrets and hides the deployment", async () => {
    const u = await seedUser();
    const dep = await seedClusterDeployment(u.id, {
      status: "done",
      spacesSecretAccessKey: "SECRET",
      kubeconfig: "KC",
    });

    await caller(u).dismiss({ id: dep.id });

    const [row] = await db
      .select()
      .from(clusterDeployment)
      .where(eq(clusterDeployment.id, dep.id));
    expect(row!.status).toBe("dismissed");
    expect(row!.spacesSecretAccessKey).toBeNull();
    expect(row!.kubeconfig).toBeNull();
    // And it's hidden from status().
    expect(await caller(u).status()).toBeNull();
  });
});
