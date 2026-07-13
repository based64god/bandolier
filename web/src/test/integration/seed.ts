import crypto from "crypto";

import { createApiKey } from "~/server/agents/api-keys";
import { db } from "~/server/db";
import {
  account,
  apiKey,
  clusterDeployment,
  pendingAgentRun,
  pushSubscription,
  repoWebhookConfig,
  taskRun,
  user,
  userAnthropicCredentials,
  userKubeconfig,
} from "~/server/db/schema";

// Row factories for the integration suites. Almost every table hangs off
// user.id, so seedUser comes first; the rest satisfy the FKs a scenario needs.
// Factories return the inserted row (or its useful identifiers) so a test can
// assert against real ids rather than guessing them.

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function seedUser(
  overrides: Partial<typeof user.$inferInsert> = {},
): Promise<typeof user.$inferSelect> {
  const id = overrides.id ?? uniq("user");
  const [row] = await db
    .insert(user)
    .values({
      id,
      name: overrides.name ?? "Test User",
      email: overrides.email ?? `${id}@test.local`,
      emailVerified: overrides.emailVerified ?? true,
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedAccount(
  userId: string,
  overrides: Partial<typeof account.$inferInsert> = {},
): Promise<typeof account.$inferSelect> {
  const [row] = await db
    .insert(account)
    .values({
      id: overrides.id ?? uniq("account"),
      accountId: overrides.accountId ?? uniq("gh"),
      providerId: overrides.providerId ?? "github",
      userId,
      accessToken: overrides.accessToken ?? "gho_test_token",
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
      ...overrides,
    })
    .returning();
  return row!;
}

// seedApiKey mints a real key through the PRODUCTION createApiKey (real SHA-256
// hash + bnd_ prefix), so tests hold the plaintext once and the row is exactly
// what the app would write.
export async function seedApiKey(
  userId: string,
  opts: { name?: string; expiresAt?: Date | null } = {},
) {
  return createApiKey(
    db,
    userId,
    opts.name ?? "test key",
    opts.expiresAt ?? null,
  );
}

export async function seedTaskRun(
  overrides: Partial<typeof taskRun.$inferInsert> = {},
): Promise<typeof taskRun.$inferSelect> {
  const jobName = overrides.jobName ?? uniq("job");
  const [row] = await db
    .insert(taskRun)
    .values({
      jobName,
      namespace: overrides.namespace ?? "agents",
      displayName: overrides.displayName ?? "test run",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedClusterDeployment(
  userId: string,
  overrides: Partial<typeof clusterDeployment.$inferInsert> = {},
): Promise<typeof clusterDeployment.$inferSelect> {
  const [row] = await db
    .insert(clusterDeployment)
    .values({
      id: overrides.id ?? uniq("deploy"),
      userId,
      status: overrides.status ?? "creating-cluster",
      clusterName: overrides.clusterName ?? "bandolier-agents",
      region: overrides.region ?? "nyc3",
      nodeSize: overrides.nodeSize ?? "s-2vcpu-4gb",
      minNodes: overrides.minNodes ?? 1,
      maxNodes: overrides.maxNodes ?? 3,
      spacesEnabled: overrides.spacesEnabled ?? true,
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedKubeconfig(
  userId: string,
  kubeconfig = "apiVersion: v1\nkind: Config\n",
): Promise<void> {
  await db.insert(userKubeconfig).values({ userId, kubeconfig });
}

export async function seedAnthropicCredential(
  userId: string,
  apiKeyValue = "sk-ant-test",
): Promise<void> {
  await db.insert(userAnthropicCredentials).values({ userId, apiKey: apiKeyValue });
}

// seedRepoWebhookConfig inserts a repo's config row (one row per repo, keyed by
// repoFullName — not an FK to any user). Defaults leave every optional column
// null so a test can seed exactly the columns it asserts on.
export async function seedRepoWebhookConfig(
  repoFullName: string,
  overrides: Partial<typeof repoWebhookConfig.$inferInsert> = {},
): Promise<typeof repoWebhookConfig.$inferSelect> {
  const [row] = await db
    .insert(repoWebhookConfig)
    .values({ repoFullName, ...overrides })
    .returning();
  return row!;
}

// seedPendingRun inserts a held (credential-gated) run. The full createAgentJob
// spec is stored as JSON in the `payload` column, so pass `spec` (an object) and
// it is serialized the way storePendingRun would — approval replays it verbatim.
export async function seedPendingRun(
  overrides: Partial<typeof pendingAgentRun.$inferInsert> & {
    spec?: Record<string, unknown>;
  } = {},
): Promise<typeof pendingAgentRun.$inferSelect> {
  const { spec, ...rest } = overrides;
  const payload = rest.payload ?? JSON.stringify(spec ?? {});
  const [row] = await db
    .insert(pendingAgentRun)
    .values({
      id: rest.id ?? uniq("pending"),
      repoFullName: rest.repoFullName ?? "acme/widgets",
      issueNumber: rest.issueNumber ?? 1,
      requestedByLogin: rest.requestedByLogin ?? "contributor",
      ...rest,
      payload,
    })
    .returning();
  return row!;
}

// seedPushSubscription inserts a browser push subscription (endpoint is the
// natural key; userId is an FK to user with ON DELETE CASCADE).
export async function seedPushSubscription(
  userId: string,
  overrides: Partial<typeof pushSubscription.$inferInsert> = {},
): Promise<typeof pushSubscription.$inferSelect> {
  const [row] = await db
    .insert(pushSubscription)
    .values({
      endpoint: overrides.endpoint ?? uniq("https://push.example.com/ep"),
      userId,
      p256dh: overrides.p256dh ?? "p256dh-key",
      auth: overrides.auth ?? "auth-key",
      ...overrides,
    })
    .returning();
  return row!;
}

// countRows is a small assertion helper: how many rows a table currently holds
// (optionally scoped), for cascade/uniqueness checks.
export { apiKey };
