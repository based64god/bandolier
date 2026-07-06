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
  createFullAccessSpacesKey,
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
import { clusterDeployment } from "~/server/db/schema";
import { getCoreV1Api, getRbacAuthorizationV1Api } from "~/server/k8s/client";

// One-click DigitalOcean deploy: the serverless-safe equivalent of
// deploy/terraform/digitalocean with agent_only=true. There is no background
// worker — the client polls, and every poll advances the deployment one
// idempotent step. Each step derives its idempotency from stable names
// (cluster name, bucket name, key name), so a re-tick after a crash or a
// concurrent poll adopts what already exists instead of duplicating it.
//
// The user's API token is NEVER persisted: the client holds it in memory and
// sends it with every tick, so it exists server-side only for the duration of
// a request. The temporary full-access Spaces key needed to create the bucket
// is likewise minted, used, and deleted within a single request.

// Shape and defaults live in ~/lib/cluster-deploy (shared with the UI).

/** Overall deadline: a DOKS cluster is ready in ~5-10 minutes; if the whole
 * deployment hasn't finished well past that, stop burning polls and surface a
 * failure the user can clean up. */
const DEPLOY_DEADLINE_MS = 45 * 60 * 1000;

type DeploymentRow = typeof clusterDeployment.$inferSelect;

// ── Creation ──────────────────────────────────────────────────────────────────

export interface StartClusterDeploymentInput {
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
    })
    .returning();
  return row!;
}

// ── Advancing ─────────────────────────────────────────────────────────────────

/** Advance the deployment one step, using the caller-supplied API token for
 * this request only. Safe to call repeatedly and concurrently: every step is
 * idempotent and a no-op tick (still waiting) just returns the row. Transient
 * errors are recorded on the row and retried on the next poll; credential
 * errors and dead clusters fail the deployment. */
export async function advanceClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
  doToken: string,
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
        return await stepEnsureCluster(database, row, doToken);
      case "waiting-cluster":
        return await stepWaitCluster(database, row, doToken);
      case "creating-bucket":
        return await stepCreateBucket(database, row, doToken);
      case "creating-key":
        return await stepCreateKey(database, row, doToken);
      case "bootstrapping-kubeconfig":
        return await stepBootstrapKubeconfig(database, row, doToken);
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
  token: string,
): Promise<DeploymentRow> {
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
  token: string,
): Promise<DeploymentRow> {
  const cluster = await getDoksCluster(token, row.clusterId!);
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

function spacesS3Client(
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
): S3Client {
  return new S3Client({
    region,
    endpoint: `https://${region}.digitaloceanspaces.com`,
    forcePathStyle: false,
    credentials,
  });
}

function bootstrapKeyName(row: DeploymentRow): string {
  return `${row.clusterName}-bootstrap`;
}

/** Run `fn` with a temporary full-access Spaces key that exists only for the
 * duration of this request: minted here, deleted in the finally. The bucket
 * API authenticates with Spaces keys rather than the API token, so bucket
 * create/delete needs one — but it is never asked of the user and never
 * persisted. A stale same-named key from a crashed request is deleted first
 * (its secret is unrecoverable anyway). */
async function withBootstrapKey<T>(
  token: string,
  row: DeploymentRow,
  fn: (credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  }) => Promise<T>,
): Promise<T> {
  const name = bootstrapKeyName(row);
  const stale = await findSpacesKeyByName(token, name);
  if (stale) await deleteSpacesKey(token, stale.accessKey);
  const key = await createFullAccessSpacesKey(token, name);
  try {
    return await fn({
      accessKeyId: key.accessKey,
      secretAccessKey: key.secretKey,
    });
  } finally {
    // Best-effort: a failure here leaves a stale key that the next call's
    // delete-by-name sweep removes.
    await deleteSpacesKey(token, key.accessKey).catch(() => undefined);
  }
}

async function stepCreateBucket(
  database: typeof Database,
  row: DeploymentRow,
  token: string,
): Promise<DeploymentRow> {
  await withBootstrapKey(token, row, async (credentials) => {
    try {
      await spacesS3Client(row.region, credentials).send(
        new CreateBucketCommand({ Bucket: row.bucketName!, ACL: "private" }),
      );
    } catch (err) {
      // Re-tick after a crash: the bucket is already ours.
      const name = (err as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists")
        throw err;
    }
  });
  return update(database, row.id, { status: "creating-key", error: null });
}

async function stepCreateKey(
  database: typeof Database,
  row: DeploymentRow,
  token: string,
): Promise<DeploymentRow> {
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
  token: string,
): Promise<DeploymentRow> {
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

  // Done. The kubeconfig is deliberately NOT saved to the user's settings
  // here: the success screen offers copy / download / save-to-settings, with
  // an explicit overwrite confirmation when a kubeconfig already exists.
  return update(database, row.id, {
    status: "done",
    kubeconfig,
    error: null,
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

/** Best-effort teardown of whatever was created, using the caller-supplied
 * API token for this request only, then wipe the provisioned secrets and
 * dismiss. */
export async function cancelClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
  doToken: string,
): Promise<DeploymentRow> {
  const errors: string[] = [];
  const record = (fallback: string) => (err: unknown) => {
    errors.push(err instanceof Error ? err.message : fallback);
  };
  if (row.spacesAccessKeyId) {
    await deleteSpacesKey(doToken, row.spacesAccessKeyId).catch(
      record("key delete failed"),
    );
  }
  const bucketName = row.bucketName;
  if (bucketName) {
    // Deleting the bucket needs a Spaces key; mint an ephemeral one for just
    // this request (deleted again by withBootstrapKey).
    try {
      await withBootstrapKey(doToken, row, async (credentials) => {
        await spacesS3Client(row.region, credentials)
          .send(new DeleteBucketCommand({ Bucket: bucketName }))
          .catch((err: unknown) => {
            // NoSuchBucket just means we never got that far.
            if ((err as { name?: string }).name !== "NoSuchBucket")
              record("bucket delete failed")(err);
          });
      });
    } catch (err) {
      record("bucket cleanup failed")(err);
    }
  }
  if (row.clusterId) {
    await deleteDoksCluster(doToken, row.clusterId).catch(
      record("cluster delete failed"),
    );
  }
  return update(database, row.id, {
    status: "dismissed",
    error: errors.length
      ? `Cleanup incomplete — check the DigitalOcean control panel: ${errors.join("; ")}`
      : null,
    spacesSecretAccessKey: null,
    kubeconfig: null,
  });
}

/** Acknowledge a terminal deployment: wipe every remaining secret (the scoped
 * key secret and the generated kubeconfig shown on the success screen).
 * Resource ids stay for the terraform adoption bundle. */
export async function dismissClusterDeployment(
  database: typeof Database,
  row: DeploymentRow,
): Promise<DeploymentRow> {
  return update(database, row.id, {
    status: "dismissed",
    spacesSecretAccessKey: null,
    kubeconfig: null,
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
  // The failure screen offers cleanup; the client re-supplies the API token
  // for it (nothing credential-shaped lives on the row).
  return update(database, row.id, { status: "failed", error: message });
}
