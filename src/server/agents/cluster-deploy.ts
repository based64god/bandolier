import { randomBytes, randomUUID } from "crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { dump as dumpYaml } from "js-yaml";

import {
  type ClusterDeployStatus,
  isTerminalStatus,
} from "~/lib/cluster-deploy";
import { validateKubeconfig } from "~/server/agents/kubeconfig";
import {
  createDoksCluster,
  createScopedSpacesKey,
  deleteDoksCluster,
  deleteSpacesKey,
  findDoksClusterByName,
  findSpacesKeyByName,
  getDoksCluster,
  getDoksKubeconfig,
  isDoAuthError,
  latestDoksVersion,
} from "~/server/agents/digitalocean";
import { type db as Database } from "~/server/db";
import { clusterDeployment, userKubeconfig } from "~/server/db/schema";
import { getCoreV1Api, getRbacAuthorizationV1Api } from "~/server/k8s/client";

// One-click DigitalOcean deploy: the serverless-safe equivalent of
// deploy/terraform/digitalocean with agent_only=true. There is no background
// worker — the client polls, and every poll advances the deployment one
// idempotent step. Each step derives its idempotency from stable names
// (cluster name, bucket name, key name), so a re-tick after a crash or a
// concurrent poll adopts what already exists instead of duplicating it.

// Shape and defaults live in ~/lib/cluster-deploy (shared with the UI).

/** Overall deadline: a DOKS cluster is ready in ~5-10 minutes; if the whole
 * deployment hasn't finished well past that, stop burning polls and surface a
 * failure the user can clean up. */
const DEPLOY_DEADLINE_MS = 45 * 60 * 1000;

type DeploymentRow = typeof clusterDeployment.$inferSelect;

// ── Creation ──────────────────────────────────────────────────────────────────

export interface StartClusterDeploymentInput {
  doToken: string;
  spacesAccessId: string;
  spacesSecretKey: string;
  region: string;
  nodeSize: string;
  minNodes: number;
  maxNodes: number;
  spacesEnabled: boolean;
}

/** Insert a new deployment row in `pending`. Names are minted here — they are
 * the idempotency handles every later step keys off. */
export async function createClusterDeployment(
  database: typeof Database,
  userId: string,
  input: StartClusterDeploymentInput,
): Promise<DeploymentRow> {
  const suffix = randomBytes(3).toString("hex");
  const clusterName = `bandolier-${suffix}`;
  const [row] = await database
    .insert(clusterDeployment)
    .values({
      id: randomUUID(),
      userId,
      status: "pending",
      clusterName,
      region: input.region,
      nodeSize: input.nodeSize,
      minNodes: input.minNodes,
      maxNodes: input.maxNodes,
      spacesEnabled: input.spacesEnabled,
      bucketName: input.spacesEnabled ? `${clusterName}-artifacts` : null,
      doToken: input.doToken,
      spacesAccessId: input.spacesEnabled ? input.spacesAccessId : null,
      spacesSecretKey: input.spacesEnabled ? input.spacesSecretKey : null,
    })
    .returning();
  return row!;
}

// ── Advancing ─────────────────────────────────────────────────────────────────

/** Advance the deployment one step. Safe to call repeatedly and concurrently:
 * every step is idempotent and a no-op tick (still waiting) just returns the
 * row. Transient errors are recorded on the row and retried on the next poll;
 * credential errors and dead clusters fail the deployment. */
export async function advanceClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  if (isTerminalStatus(row.status)) return row;

  if (Date.now() - row.createdAt.getTime() > DEPLOY_DEADLINE_MS) {
    return fail(
      database,
      row,
      "Deployment timed out. Clean up any partially created resources, then retry.",
    );
  }

  try {
    switch (row.status as ClusterDeployStatus) {
      case "pending":
        return await stepEnsureCluster(database, row);
      case "waiting-cluster":
        return await stepWaitCluster(database, row);
      case "creating-bucket":
        return await stepCreateBucket(database, row);
      case "creating-key":
        return await stepCreateKey(database, row);
      case "bootstrapping-kubeconfig":
        return await stepBootstrapKubeconfig(database, row);
      default:
        return row;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deployment failed.";
    if (isDoAuthError(err)) return fail(database, row, message);
    // Transient: surface the error but keep the step; the next poll retries.
    return update(database, row.id, { error: message });
  }
}

async function stepEnsureCluster(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const token = row.doToken!;
  // Adopt a cluster from an earlier tick that created it but failed to record
  // it (names are unique per DO account), otherwise create one.
  const existing = await findDoksClusterByName(token, row.clusterName);
  const cluster =
    existing ??
    (await createDoksCluster(token, {
      name: row.clusterName,
      region: row.region,
      version: await latestDoksVersion(token),
      nodeSize: row.nodeSize,
      minNodes: row.minNodes,
      maxNodes: row.maxNodes,
    }));
  return update(database, row.id, {
    clusterId: cluster.id,
    k8sVersion: cluster.version,
    status: "waiting-cluster",
    error: null,
  });
}

async function stepWaitCluster(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const cluster = await getDoksCluster(row.doToken!, row.clusterId!);
  if (cluster.state === "running") {
    return update(database, row.id, {
      status: row.spacesEnabled
        ? "creating-bucket"
        : "bootstrapping-kubeconfig",
      error: null,
    });
  }
  if (cluster.state === "errored" || cluster.state === "deleted") {
    return fail(
      database,
      row,
      `Cluster entered state "${cluster.state}" while provisioning.`,
    );
  }
  return row; // still provisioning
}

function spacesS3Client(row: DeploymentRow): S3Client {
  return new S3Client({
    region: row.region,
    endpoint: `https://${row.region}.digitaloceanspaces.com`,
    forcePathStyle: false,
    credentials: {
      accessKeyId: row.spacesAccessId!,
      secretAccessKey: row.spacesSecretKey!,
    },
  });
}

async function stepCreateBucket(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  try {
    await spacesS3Client(row).send(
      new CreateBucketCommand({ Bucket: row.bucketName!, ACL: "private" }),
    );
  } catch (err) {
    // Re-tick after a crash: the bucket is already ours.
    const name = (err as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists")
      throw err;
  }
  return update(database, row.id, { status: "creating-key", error: null });
}

async function stepCreateKey(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const token = row.doToken!;
  const keyName = `${row.clusterName}-artifacts`;
  // The API only reveals a key's secret at creation. If a previous tick
  // created the key but crashed before persisting the secret, delete and
  // re-mint — the name is ours (it embeds the generated cluster name).
  const existing = await findSpacesKeyByName(token, keyName);
  if (existing) await deleteSpacesKey(token, existing.accessKey);
  const key = await createScopedSpacesKey(token, {
    name: keyName,
    bucket: row.bucketName!,
  });
  return update(database, row.id, {
    spacesAccessKeyId: key.accessKey,
    spacesSecretAccessKey: key.secretKey,
    status: "bootstrapping-kubeconfig",
    error: null,
  });
}

// ── ServiceAccount kubeconfig bootstrap ───────────────────────────────────────
// The programmatic version of the "Agent-cluster kubeconfig" script in
// deploy/terraform/digitalocean/README.md: DOKS user tokens expire in ~a week,
// so the stored kubeconfig is built on a ServiceAccount with a long-lived
// token instead of the admin kubeconfig used to create it.

const SA_NAMESPACE = "kube-system";
const SA_NAME = "bandolier-deployer";
const SA_TOKEN_SECRET = "bandolier-deployer-token";

async function stepBootstrapKubeconfig(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const token = row.doToken!;
  const adminKubeconfig = await getDoksKubeconfig(token, row.clusterId!);
  const cluster = await getDoksCluster(token, row.clusterId!);

  const core = getCoreV1Api(adminKubeconfig);
  const rbac = getRbacAuthorizationV1Api(adminKubeconfig);

  const ignoreConflict = (err: unknown) => {
    if ((err as { code?: number }).code !== 409) throw err;
  };

  await core
    .createNamespacedServiceAccount({
      namespace: SA_NAMESPACE,
      body: { metadata: { name: SA_NAME, namespace: SA_NAMESPACE } },
    })
    .catch(ignoreConflict);

  // The app creates namespaces, Jobs, Secrets, and NetworkPolicies on this
  // cluster, so the ServiceAccount gets cluster-admin — same as the documented
  // manual bootstrap.
  await rbac
    .createClusterRoleBinding({
      body: {
        metadata: { name: SA_NAME },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: "cluster-admin",
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: SA_NAME,
            namespace: SA_NAMESPACE,
          },
        ],
      },
    })
    .catch(ignoreConflict);

  await core
    .createNamespacedSecret({
      namespace: SA_NAMESPACE,
      body: {
        metadata: {
          name: SA_TOKEN_SECRET,
          namespace: SA_NAMESPACE,
          annotations: { "kubernetes.io/service-account.name": SA_NAME },
        },
        type: "kubernetes.io/service-account-token",
      },
    })
    .catch(ignoreConflict);

  // The token controller fills the secret asynchronously; if it hasn't yet,
  // stay in this step and let the next poll pick it up.
  const secret = await core.readNamespacedSecret({
    name: SA_TOKEN_SECRET,
    namespace: SA_NAMESPACE,
  });
  const tokenB64 = secret.data?.token;
  const caB64 = secret.data?.["ca.crt"];
  if (!tokenB64 || !caB64) return row;

  const kubeconfig = buildServiceAccountKubeconfig({
    clusterName: row.clusterName,
    server: cluster.endpoint,
    caData: caB64,
    token: Buffer.from(tokenB64, "base64").toString("utf8"),
  });

  const validation = await validateKubeconfig(kubeconfig);
  if (!validation.valid) {
    // The cluster is up but the SA config failed its probe — likely transient
    // (API server still settling); retry on the next poll.
    return update(database, row.id, {
      error: `Generated kubeconfig failed validation: ${validation.error}`,
    });
  }

  await database
    .insert(userKubeconfig)
    .values({ userId: row.userId, kubeconfig })
    .onConflictDoUpdate({
      target: userKubeconfig.userId,
      set: { kubeconfig, updatedAt: new Date() },
    });

  // Done — the one-shot admin credentials have served their purpose.
  return update(database, row.id, {
    status: "done",
    error: null,
    doToken: null,
    spacesAccessId: null,
    spacesSecretKey: null,
  });
}

/** Assemble the long-lived ServiceAccount kubeconfig (pure; exported for
 * tests). Matches the shape produced by the terraform README's script. */
export function buildServiceAccountKubeconfig(opts: {
  clusterName: string;
  server: string;
  caData: string;
  token: string;
}): string {
  return dumpYaml({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: opts.clusterName,
        cluster: {
          server: opts.server,
          "certificate-authority-data": opts.caData,
        },
      },
    ],
    users: [{ name: SA_NAME, user: { token: opts.token } }],
    contexts: [
      {
        name: opts.clusterName,
        context: { cluster: opts.clusterName, user: SA_NAME },
      },
    ],
    "current-context": opts.clusterName,
  });
}

// ── Cancel / dismiss ──────────────────────────────────────────────────────────

/** Best-effort teardown of whatever was created, then wipe credentials and
 * dismiss. Only callable while the admin credentials are still on the row. */
export async function cancelClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  const errors: string[] = [];
  if (row.doToken) {
    if (row.spacesAccessKeyId) {
      await deleteSpacesKey(row.doToken, row.spacesAccessKeyId).catch(
        (err: unknown) =>
          errors.push(err instanceof Error ? err.message : "key delete failed"),
      );
    }
    if (row.clusterId) {
      await deleteDoksCluster(row.doToken, row.clusterId).catch(
        (err: unknown) =>
          errors.push(
            err instanceof Error ? err.message : "cluster delete failed",
          ),
      );
    }
  }
  if (row.spacesAccessId && row.spacesSecretKey && row.bucketName) {
    await spacesS3Client(row)
      .send(new DeleteBucketCommand({ Bucket: row.bucketName }))
      .catch((err: unknown) => {
        // NoSuchBucket just means we never got that far.
        if ((err as { name?: string }).name !== "NoSuchBucket")
          errors.push(
            err instanceof Error ? err.message : "bucket delete failed",
          );
      });
  }
  return update(database, row.id, {
    status: "dismissed",
    error: errors.length
      ? `Cleanup incomplete — check the DigitalOcean control panel: ${errors.join("; ")}`
      : null,
    doToken: null,
    spacesAccessId: null,
    spacesSecretKey: null,
    spacesSecretAccessKey: null,
  });
}

/** Acknowledge a terminal deployment: wipe every remaining secret (including
 * the scoped key secret shown on the success screen). Resource ids stay for
 * the terraform adoption bundle. */
export async function dismissClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  return update(database, row.id, {
    status: "dismissed",
    doToken: null,
    spacesAccessId: null,
    spacesSecretKey: null,
    spacesSecretAccessKey: null,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function update(
  database: typeof Database,
  id: string,
  set: Partial<typeof clusterDeployment.$inferInsert>,
): Promise<DeploymentRow> {
  const [row] = await database
    .update(clusterDeployment)
    .set(set)
    .where(eq(clusterDeployment.id, id))
    .returning();
  return row!;
}

function fail(
  database: typeof Database,
  row: DeploymentRow,
  message: string,
): Promise<DeploymentRow> {
  // Keep the admin credentials: the failure screen offers cleanup, which
  // needs them. They are wiped when the user cancels or dismisses.
  return update(database, row.id, { status: "failed", error: message });
}
