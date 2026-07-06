import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { load as loadYaml } from "js-yaml";

import type { db as Database } from "~/server/db";
import type * as DigitalOcean from "~/server/agents/digitalocean";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("~/server/agents/digitalocean", async (importOriginal) => {
  const actual = await importOriginal<typeof DigitalOcean>();
  return {
    ...actual,
    latestDoksVersion: vi.fn(),
    createDoksCluster: vi.fn(),
    createFullAccessSpacesKey: vi.fn(),
    findDoksClusterByName: vi.fn(),
    getDoksCluster: vi.fn(),
    getDoksKubeconfig: vi.fn(),
    createScopedSpacesKey: vi.fn(),
    findSpacesKeyByName: vi.fn(),
    deleteSpacesKey: vi.fn(),
    deleteDoksCluster: vi.fn(),
  };
});

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send = s3Send;
    },
    CreateBucketCommand: class extends FakeCommand {},
    DeleteBucketCommand: class extends FakeCommand {},
  };
});

const coreApi = {
  createNamespacedServiceAccount: vi.fn(),
  createNamespacedSecret: vi.fn(),
  readNamespacedSecret: vi.fn(),
};
const rbacApi = { createClusterRoleBinding: vi.fn() };
vi.mock("~/server/k8s/client", () => ({
  getCoreV1Api: () => coreApi,
  getRbacAuthorizationV1Api: () => rbacApi,
}));

vi.mock("~/server/agents/kubeconfig", () => ({
  validateKubeconfig: vi.fn(),
}));

import {
  DoApiError,
  createDoksCluster,
  createFullAccessSpacesKey,
  createScopedSpacesKey,
  deleteDoksCluster,
  deleteSpacesKey,
  findDoksClusterByName,
  findSpacesKeyByName,
  getDoksCluster,
  getDoksKubeconfig,
  latestDoksVersion,
} from "~/server/agents/digitalocean";
import { validateKubeconfig } from "~/server/agents/kubeconfig";
import {
  advanceClusterDeployment,
  buildServiceAccountKubeconfig,
  cancelClusterDeployment,
  createClusterDeployment,
  dismissClusterDeployment,
} from "~/server/agents/cluster-deploy";

// ── Fake drizzle ──────────────────────────────────────────────────────────────
// Duck-typed chains for the exact queries the module issues: updates mutate a
// single tracked deployment row; inserts are recorded (deployment insert
// returns the row, the userKubeconfig upsert resolves void).

interface FakeDb {
  db: typeof Database;
  row: () => Record<string, unknown>;
  seed: (row: Record<string, unknown>) => void;
  kubeconfigUpserts: Record<string, unknown>[];
}

function fakeDb(initial: Record<string, unknown> = {}): FakeDb {
  let row = { ...initial };
  const kubeconfigUpserts: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            row = { ...row, ...set };
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          row = { ...values };
          return Promise.resolve([row]);
        },
        onConflictDoUpdate: () => {
          kubeconfigUpserts.push(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as typeof Database;
  return {
    db,
    row: () => row,
    seed: (r) => {
      row = { ...r };
    },
    kubeconfigUpserts,
  };
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    userId: "user-1",
    status: "pending",
    error: null,
    clusterName: "bandolier-abc123",
    region: "nyc3",
    nodeSize: "s-4vcpu-8gb",
    minNodes: 1,
    maxNodes: 4,
    haControlPlane: false,
    spacesEnabled: true,
    clusterId: null,
    k8sVersion: null,
    bucketName: "bandolier-abc123-artifacts",
    spacesAccessKeyId: null,
    spacesSecretAccessKey: null,
    kubeconfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// The row type is the drizzle inferred select; the fake rows are structurally
// identical, so a single cast at the call boundary keeps the tests readable.
// Seeding the fake with the same row keeps partial updates (e.g. error-only)
// from dropping the untouched columns.
async function advance(fake: FakeDb, row: Record<string, unknown>) {
  fake.seed(row);
  return advanceClusterDeployment(
    fake.db,
    row as Parameters<typeof advanceClusterDeployment>[1],
    "dop_v1_test",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Creation ──────────────────────────────────────────────────────────────────

describe("createClusterDeployment", () => {
  it("mints unique name-derived idempotency handles and stores no credentials", async () => {
    const fake = fakeDb();
    const row = await createClusterDeployment(fake.db, "user-1", {
      region: "fra1",
      nodeSize: "s-2vcpu-4gb",
      minNodes: 1,
      maxNodes: 2,
      haControlPlane: false,
      spacesEnabled: true,
    });
    expect(row.status).toBe("pending");
    expect(row.clusterName).toMatch(/^bandolier-[0-9a-f]{6}$/);
    expect(row.bucketName).toBe(`${row.clusterName}-artifacts`);
    // The API token must never land on the row (or anywhere else in the DB).
    expect(JSON.stringify(row)).not.toContain("dop_v1");
  });

  it("skips the bucket when spaces is disabled", async () => {
    const fake = fakeDb();
    const row = await createClusterDeployment(fake.db, "user-1", {
      region: "nyc3",
      nodeSize: "s-4vcpu-8gb",
      minNodes: 1,
      maxNodes: 4,
      haControlPlane: false,
      spacesEnabled: false,
    });
    expect(row.bucketName).toBeNull();
  });
});

// ── pending → waiting-cluster ─────────────────────────────────────────────────

describe("pending step", () => {
  it("creates the cluster at the latest version and records its id", async () => {
    (findDoksClusterByName as Mock).mockResolvedValue(null);
    (latestDoksVersion as Mock).mockResolvedValue("1.32.1-do.0");
    (createDoksCluster as Mock).mockResolvedValue({
      id: "c-1",
      version: "1.32.1-do.0",
    });
    const fake = fakeDb();
    const row = await advance(fake, baseRow());
    expect(createDoksCluster).toHaveBeenCalledWith(
      "dop_v1_test",
      expect.objectContaining({
        name: "bandolier-abc123",
        region: "nyc3",
        version: "1.32.1-do.0",
      }),
    );
    expect(row.clusterId).toBe("c-1");
    expect(row.status).toBe("waiting-cluster");
  });

  it("adopts an existing same-named cluster instead of duplicating it", async () => {
    (findDoksClusterByName as Mock).mockResolvedValue({
      id: "c-orphan",
      version: "1.32.1-do.0",
    });
    const fake = fakeDb();
    const row = await advance(fake, baseRow());
    expect(createDoksCluster).not.toHaveBeenCalled();
    expect(row.clusterId).toBe("c-orphan");
    expect(row.status).toBe("waiting-cluster");
  });

  it("fails hard on a bad token", async () => {
    (findDoksClusterByName as Mock).mockRejectedValue(
      new DoApiError(401, "Unable to authenticate you"),
    );
    const fake = fakeDb();
    const row = await advance(fake, baseRow());
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Unable to authenticate you");
  });

  it("fails hard on a 422 validation error (e.g. droplet limit) instead of retrying forever", async () => {
    (findDoksClusterByName as Mock).mockResolvedValue(null);
    (latestDoksVersion as Mock).mockResolvedValue("1.32.1-do.0");
    (createDoksCluster as Mock).mockRejectedValue(
      new DoApiError(
        422,
        "validation error: autoscale desired max nodes exceed limits",
      ),
    );
    const fake = fakeDb();
    const row = await advance(fake, baseRow());
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/max nodes exceed limits/);
  });

  it("records transient errors without leaving the step", async () => {
    (findDoksClusterByName as Mock).mockRejectedValue(
      new DoApiError(500, "server error"),
    );
    const fake = fakeDb();
    const row = await advance(fake, baseRow());
    expect(row.status).toBe("pending");
    expect(row.error).toBe("server error");
  });
});

// ── waiting-cluster ───────────────────────────────────────────────────────────

describe("waiting-cluster step", () => {
  it("stays while provisioning", async () => {
    (getDoksCluster as Mock).mockResolvedValue({ state: "provisioning" });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "waiting-cluster", clusterId: "c-1" }),
    );
    expect(row.status).toBe("waiting-cluster");
  });

  it("moves to bucket creation once running", async () => {
    (getDoksCluster as Mock).mockResolvedValue({ state: "running" });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "waiting-cluster", clusterId: "c-1" }),
    );
    expect(row.status).toBe("creating-bucket");
  });

  it("skips straight to kubeconfig bootstrap when spaces is disabled", async () => {
    (getDoksCluster as Mock).mockResolvedValue({ state: "running" });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({
        status: "waiting-cluster",
        clusterId: "c-1",
        spacesEnabled: false,
      }),
    );
    expect(row.status).toBe("bootstrapping-kubeconfig");
  });

  it("explains a 404 as a token-scope problem instead of a bare Not Found", async () => {
    (getDoksCluster as Mock).mockRejectedValue(
      new DoApiError(404, "Not Found"),
    );
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "waiting-cluster", clusterId: "c-1" }),
    );
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/token likely/);
    expect(row.error).toMatch(/Full Access/);
  });

  it("fails when the cluster errors out", async () => {
    (getDoksCluster as Mock).mockResolvedValue({ state: "errored" });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "waiting-cluster", clusterId: "c-1" }),
    );
    expect(row.status).toBe("failed");
  });

  it("fails once past the overall deadline", async () => {
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({
        status: "waiting-cluster",
        clusterId: "c-1",
        createdAt: new Date(Date.now() - 46 * 60 * 1000),
      }),
    );
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/timed out/i);
  });
});

// ── creating-bucket / creating-key ────────────────────────────────────────────

describe("creating-bucket step", () => {
  beforeEach(() => {
    (deleteSpacesKey as Mock).mockResolvedValue(undefined);
  });

  it("mints an ephemeral full-access key, creates the bucket, then deletes the key", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "BOOT_AK",
      secretKey: "boot-secret",
    });
    s3Send.mockResolvedValue({});
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "creating-bucket", clusterId: "c-1" }),
    );
    expect(createFullAccessSpacesKey).toHaveBeenCalledWith(
      "dop_v1_test",
      "bandolier-abc123-bootstrap",
    );
    expect(s3Send).toHaveBeenCalledTimes(1);
    // The key exists only for the duration of the request…
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "BOOT_AK");
    // …and never touches the row.
    expect(JSON.stringify(row)).not.toContain("BOOT_AK");
    expect(JSON.stringify(row)).not.toContain("boot-secret");
    expect(row.status).toBe("creating-key");
  });

  it("sweeps a stale same-named key from a crashed request before minting", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue({
      name: "bandolier-abc123-bootstrap",
      accessKey: "OLD_BOOT_AK",
    });
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "NEW_BOOT_AK",
      secretKey: "new-boot-secret",
    });
    s3Send.mockResolvedValue({});
    const fake = fakeDb();
    await advance(
      fake,
      baseRow({ status: "creating-bucket", clusterId: "c-1" }),
    );
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "OLD_BOOT_AK");
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "NEW_BOOT_AK");
  });

  it("deletes the ephemeral key even when bucket creation fails", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "BOOT_AK",
      secretKey: "boot-secret",
    });
    s3Send.mockRejectedValue(
      Object.assign(new Error("boom"), { name: "Boom" }),
    );
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "creating-bucket", clusterId: "c-1" }),
    );
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "BOOT_AK");
    expect(row.status).toBe("creating-bucket"); // transient error, retried
    expect(row.error).toBe("boom");
  });

  it("tolerates a bucket we already own (re-tick)", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "BOOT_AK",
      secretKey: "boot-secret",
    });
    s3Send.mockRejectedValue(
      Object.assign(new Error("owned"), { name: "BucketAlreadyOwnedByYou" }),
    );
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "creating-bucket", clusterId: "c-1" }),
    );
    expect(row.status).toBe("creating-key");
  });
});

describe("creating-key step", () => {
  it("mints the scoped key and stores both halves for the success screen", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createScopedSpacesKey as Mock).mockResolvedValue({
      accessKey: "SCOPED_AK",
      secretKey: "scoped-secret",
    });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "creating-key", clusterId: "c-1" }),
    );
    expect(createScopedSpacesKey).toHaveBeenCalledWith("dop_v1_test", {
      name: "bandolier-abc123-artifacts",
      bucket: "bandolier-abc123-artifacts",
    });
    expect(row.spacesAccessKeyId).toBe("SCOPED_AK");
    expect(row.spacesSecretAccessKey).toBe("scoped-secret");
    expect(row.status).toBe("bootstrapping-kubeconfig");
  });

  it("re-mints (delete + create) when a same-named key exists, since its secret is unrecoverable", async () => {
    (findSpacesKeyByName as Mock).mockResolvedValue({
      name: "bandolier-abc123-artifacts",
      accessKey: "OLD_AK",
    });
    (createScopedSpacesKey as Mock).mockResolvedValue({
      accessKey: "NEW_AK",
      secretKey: "new-secret",
    });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "creating-key", clusterId: "c-1" }),
    );
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "OLD_AK");
    expect(row.spacesAccessKeyId).toBe("NEW_AK");
  });
});

// ── bootstrapping-kubeconfig ──────────────────────────────────────────────────

function primeBootstrapMocks(opts?: { secretReady?: boolean }) {
  (getDoksKubeconfig as Mock).mockResolvedValue("admin-kubeconfig");
  (getDoksCluster as Mock).mockResolvedValue({
    state: "running",
    endpoint: "https://c-1.k8s.ondigitalocean.com",
  });
  coreApi.createNamespacedServiceAccount.mockResolvedValue({});
  rbacApi.createClusterRoleBinding.mockResolvedValue({});
  coreApi.createNamespacedSecret.mockResolvedValue({});
  coreApi.readNamespacedSecret.mockResolvedValue(
    opts?.secretReady === false
      ? { data: {} }
      : {
          data: {
            token: Buffer.from("sa-token").toString("base64"),
            "ca.crt": Buffer.from("CA PEM").toString("base64"),
          },
        },
  );
  (validateKubeconfig as Mock).mockResolvedValue({
    valid: true,
    version: "v1.32.1",
  });
}

describe("bootstrapping-kubeconfig step", () => {
  it("builds the ServiceAccount kubeconfig onto the row (no auto-save)", async () => {
    primeBootstrapMocks();
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "bootstrapping-kubeconfig", clusterId: "c-1" }),
    );

    expect(row.status).toBe("done");
    // The kubeconfig and scoped-key secret survive until dismissal — the
    // success screen offers copy / download / explicit insert; nothing is
    // written into the user's settings without their confirmation.
    expect(fake.kubeconfigUpserts).toHaveLength(0);
    const parsed = loadYaml(row.kubeconfig!) as {
      clusters: { cluster: { server: string } }[];
      users: { user: { token: string } }[];
    };
    expect(parsed.clusters[0]!.cluster.server).toBe(
      "https://c-1.k8s.ondigitalocean.com",
    );
    expect(parsed.users[0]!.user.token).toBe("sa-token");
  });

  it("stays in the step while the token controller hasn't filled the secret", async () => {
    primeBootstrapMocks({ secretReady: false });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "bootstrapping-kubeconfig", clusterId: "c-1" }),
    );
    expect(row.status).toBe("bootstrapping-kubeconfig");
    expect(fake.kubeconfigUpserts).toHaveLength(0);
  });

  it("tolerates already-existing SA/binding/secret (409s) on a re-tick", async () => {
    primeBootstrapMocks();
    const conflict = Object.assign(new Error("conflict"), { code: 409 });
    coreApi.createNamespacedServiceAccount.mockRejectedValue(conflict);
    rbacApi.createClusterRoleBinding.mockRejectedValue(conflict);
    coreApi.createNamespacedSecret.mockRejectedValue(conflict);
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "bootstrapping-kubeconfig", clusterId: "c-1" }),
    );
    expect(row.status).toBe("done");
  });

  it("retries (with the error surfaced) when the generated kubeconfig fails validation", async () => {
    primeBootstrapMocks();
    (validateKubeconfig as Mock).mockResolvedValue({
      valid: false,
      error: "could not reach cluster",
    });
    const fake = fakeDb();
    const row = await advance(
      fake,
      baseRow({ status: "bootstrapping-kubeconfig", clusterId: "c-1" }),
    );
    expect(row.status).toBe("bootstrapping-kubeconfig");
    expect(row.error).toMatch(/failed validation/);
    expect(fake.kubeconfigUpserts).toHaveLength(0);
  });
});

// ── Terminal handling ─────────────────────────────────────────────────────────

describe("terminal deployments", () => {
  it("advance is a no-op on done/failed/dismissed", async () => {
    const fake = fakeDb();
    for (const status of ["done", "failed", "dismissed"]) {
      const row = await advance(fake, baseRow({ status }));
      expect(row.status).toBe(status);
    }
    expect(getDoksCluster).not.toHaveBeenCalled();
  });

  it("dismiss wipes every remaining secret but keeps resource ids", async () => {
    const fake = fakeDb();
    const seeded = baseRow({
      status: "done",
      clusterId: "c-1",
      spacesAccessKeyId: "SCOPED_AK",
      spacesSecretAccessKey: "scoped-secret",
      kubeconfig: "apiVersion: v1\nkind: Config\n",
      doToken: null,
    });
    fake.seed(seeded);
    const row = await dismissClusterDeployment(fake.db, seeded);
    expect(row.status).toBe("dismissed");
    expect(row.spacesSecretAccessKey).toBeNull();
    expect(row.kubeconfig).toBeNull();
    expect(row.clusterId).toBe("c-1");
    expect(row.spacesAccessKeyId).toBe("SCOPED_AK");
  });

  it("cancel best-effort deletes key, cluster, and bucket, then wipes creds", async () => {
    (deleteSpacesKey as Mock).mockResolvedValue(undefined);
    (deleteDoksCluster as Mock).mockResolvedValue(undefined);
    // Bucket deletion mints an ephemeral bootstrap key for just this request.
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "BOOT_AK",
      secretKey: "boot-secret",
    });
    s3Send.mockResolvedValue({});
    const fake = fakeDb();
    const seeded = baseRow({
      status: "failed",
      clusterId: "c-1",
      spacesAccessKeyId: "SCOPED_AK",
    });
    fake.seed(seeded);
    const row = await cancelClusterDeployment(fake.db, seeded, "dop_v1_test");
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "SCOPED_AK");
    expect(deleteSpacesKey).toHaveBeenCalledWith("dop_v1_test", "BOOT_AK");
    expect(deleteDoksCluster).toHaveBeenCalledWith("dop_v1_test", "c-1");
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("dismissed");
    expect(row.error).toBeNull();
    // The caller-supplied token never lands on the row.
    expect(JSON.stringify(row)).not.toContain("dop_v1_test");
  });

  it("cancel reports partial cleanup instead of throwing", async () => {
    (deleteSpacesKey as Mock).mockResolvedValue(undefined);
    (deleteDoksCluster as Mock).mockRejectedValue(new Error("api down"));
    (findSpacesKeyByName as Mock).mockResolvedValue(null);
    (createFullAccessSpacesKey as Mock).mockResolvedValue({
      accessKey: "BOOT_AK",
      secretKey: "boot-secret",
    });
    s3Send.mockRejectedValue(
      Object.assign(new Error("gone"), { name: "NoSuchBucket" }),
    );
    const fake = fakeDb();
    const seeded = baseRow({
      status: "failed",
      clusterId: "c-1",
      spacesAccessKeyId: "SCOPED_AK",
    });
    fake.seed(seeded);
    const row = await cancelClusterDeployment(fake.db, seeded, "dop_v1_test");
    expect(row.status).toBe("dismissed");
    expect(row.error).toMatch(/Cleanup incomplete/);
    expect(row.error).toMatch(/api down/);
    expect(row.error).not.toMatch(/gone/); // NoSuchBucket is benign
  });
});

// ── Kubeconfig assembly ───────────────────────────────────────────────────────

describe("buildServiceAccountKubeconfig", () => {
  it("produces the same shape as the terraform README script", () => {
    const yaml = buildServiceAccountKubeconfig({
      clusterName: "bandolier-abc123",
      server: "https://example.k8s.ondigitalocean.com",
      caData: "Q0E=",
      token: "sa-token",
    });
    const parsed = loadYaml(yaml) as Record<string, unknown>;
    expect(parsed).toEqual({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "bandolier-abc123",
          cluster: {
            server: "https://example.k8s.ondigitalocean.com",
            "certificate-authority-data": "Q0E=",
          },
        },
      ],
      users: [{ name: "bandolier-deployer", user: { token: "sa-token" } }],
      contexts: [
        {
          name: "bandolier-abc123",
          context: { cluster: "bandolier-abc123", user: "bandolier-deployer" },
        },
      ],
      "current-context": "bandolier-abc123",
    });
  });
});
