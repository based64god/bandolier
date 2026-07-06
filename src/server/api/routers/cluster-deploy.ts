import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  CLUSTER_DEPLOY_DEFAULTS,
  DO_REGIONS,
  isTerminalStatus,
} from "~/lib/cluster-deploy";
import {
  advanceClusterDeployment,
  cancelClusterDeployment,
  createClusterDeployment,
  dismissClusterDeployment,
} from "~/server/agents/cluster-deploy";
import {
  getDropletCapacity,
  validateDoToken,
} from "~/server/agents/digitalocean";
import { stripWhitespace } from "~/server/api/credentials";
import { type db } from "~/server/db";
import { clusterDeployment, userKubeconfig } from "~/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { buildAdoptionBundle } from "~/server/agents/terraform-adoption";

// One-click DigitalOcean agent-cluster deploy. All procedures are user-scoped:
// a deployment belongs to the user who started it and ends in their personal
// kubeconfig slot. The client drives the state machine by polling `tick` —
// there is no server-side background work, so this holds on serverless too.

type DeploymentRow = typeof clusterDeployment.$inferSelect;

/** What the client is allowed to see. The one-shot admin credentials never
 * leave the server; the scoped artifact-storage key secret is exposed only on
 * the success screen (status "done") until the user dismisses it. */
function toClientDeployment(row: DeploymentRow) {
  return {
    id: row.id,
    status: row.status,
    error: row.error,
    clusterName: row.clusterName,
    region: row.region,
    nodeSize: row.nodeSize,
    minNodes: row.minNodes,
    maxNodes: row.maxNodes,
    spacesEnabled: row.spacesEnabled,
    clusterId: row.clusterId,
    bucketName: row.bucketName,
    spacesEndpoint: row.spacesEnabled
      ? `https://${row.region}.digitaloceanspaces.com`
      : null,
    spacesAccessKeyId: row.spacesAccessKeyId,
    spacesSecretAccessKey:
      row.status === "done" ? row.spacesSecretAccessKey : null,
    // The generated ServiceAccount kubeconfig, offered on the success screen
    // for copy / download / explicit save; wiped on dismissal.
    kubeconfig: row.status === "done" ? row.kubeconfig : null,
    createdAt: row.createdAt,
  };
}

async function latestDeployment(
  database: typeof db,
  userId: string,
): Promise<DeploymentRow | null> {
  const [row] = await database
    .select()
    .from(clusterDeployment)
    .where(eq(clusterDeployment.userId, userId))
    .orderBy(desc(clusterDeployment.createdAt))
    .limit(1);
  return row ?? null;
}

async function ownedDeployment(
  database: typeof db,
  userId: string,
  id: string,
): Promise<DeploymentRow> {
  const [row] = await database
    .select()
    .from(clusterDeployment)
    .where(eq(clusterDeployment.id, id))
    .limit(1);
  if (row?.userId !== userId) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

export const clusterDeployRouter = createTRPCRouter({
  // The latest deployment, unless the user has dismissed it. Drives the whole
  // wizard: null → offer the form; non-terminal → progress; done/failed →
  // success/failure screen.
  status: protectedProcedure.query(async ({ ctx }) => {
    const row = await latestDeployment(ctx.db, ctx.session.user.id);
    if (!row || row.status === "dismissed") return null;
    return toClientDeployment(row);
  }),

  start: protectedProcedure
    .input(
      z
        .object({
          // Strip pasted-token artifacts (the subscription-token lesson:
          // terminal line wraps smuggle interior whitespace past format-only
          // checks).
          doToken: stripWhitespace.pipe(z.string().min(1)),
          region: z.enum(DO_REGIONS).default(CLUSTER_DEPLOY_DEFAULTS.region),
          nodeSize: z
            .string()
            .regex(/^[a-z0-9-]+$/, "Invalid droplet size slug.")
            .default(CLUSTER_DEPLOY_DEFAULTS.nodeSize),
          minNodes: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(CLUSTER_DEPLOY_DEFAULTS.minNodes),
          maxNodes: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(CLUSTER_DEPLOY_DEFAULTS.maxNodes),
          haControlPlane: z
            .boolean()
            .default(CLUSTER_DEPLOY_DEFAULTS.haControlPlane),
          spacesEnabled: z.boolean().default(true),
        })
        .refine((input) => input.maxNodes >= input.minNodes, {
          message: "maxNodes must be >= minNodes.",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await latestDeployment(ctx.db, ctx.session.user.id);
      if (existing && !isTerminalStatus(existing.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A cluster deployment is already in progress.",
        });
      }

      const probe = await validateDoToken(input.doToken);
      if (!probe.valid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: probe.error });
      }

      // Worker nodes are droplets; an autoscale max above the account's
      // remaining droplet capacity is guaranteed to be rejected by DO. Catch
      // it at submit time with the actual numbers instead of mid-deploy.
      const capacity = await getDropletCapacity(input.doToken);
      if (input.maxNodes > capacity.available) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Max nodes (${input.maxNodes}) exceeds your DigitalOcean account's remaining droplet capacity ` +
            `(${capacity.available} of ${capacity.limit}${capacity.inUse ? `, ${capacity.inUse} in use` : ""}). ` +
            "Lower max nodes or request a droplet limit increase from DigitalOcean.",
        });
      }

      // The token is used for the pre-flight probe above and then dropped —
      // it is never written to the database. The client keeps it in memory
      // and sends it with every tick/cancel.
      const row = await createClusterDeployment(ctx.db, ctx.session.user.id, {
        region: input.region,
        nodeSize: input.nodeSize,
        minNodes: input.minNodes,
        maxNodes: input.maxNodes,
        haControlPlane: input.haControlPlane,
        spacesEnabled: input.spacesEnabled,
      });
      return toClientDeployment(row);
    }),

  // Cheap probe for a re-entered token (e.g. after a page reload mid-deploy),
  // so a typo can't hard-fail an in-flight deployment on the next tick.
  checkToken: protectedProcedure
    .input(z.object({ doToken: stripWhitespace.pipe(z.string().min(1)) }))
    .mutation(({ input }) => validateDoToken(input.doToken)),

  // One poll = one state-machine step, run with the token supplied by the
  // client for this request only. Safe to call repeatedly; a terminal or
  // still-waiting deployment just returns unchanged.
  tick: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        doToken: stripWhitespace.pipe(z.string().min(1)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ownedDeployment(ctx.db, ctx.session.user.id, input.id);
      return toClientDeployment(
        await advanceClusterDeployment(ctx.db, row, input.doToken),
      );
    }),

  // Save the generated kubeconfig into the user's settings — an explicit act,
  // never automatic. The client warns and asks for confirmation first when a
  // kubeconfig is already configured; this endpoint just performs the upsert.
  saveKubeconfig: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const row = await ownedDeployment(ctx.db, ctx.session.user.id, input.id);
      const kubeconfig = row.status === "done" ? row.kubeconfig : null;
      if (!kubeconfig) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No kubeconfig to save on this deployment.",
        });
      }
      await ctx.db
        .insert(userKubeconfig)
        .values({ userId: ctx.session.user.id, kubeconfig })
        .onConflictDoUpdate({
          target: userKubeconfig.userId,
          set: { kubeconfig, updatedAt: new Date() },
        });
      return { success: true };
    }),

  // Best-effort teardown of whatever was created so a failed or abandoned
  // deploy doesn't keep billing; wipes the one-shot credentials.
  cancel: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        doToken: stripWhitespace.pipe(z.string().min(1)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ownedDeployment(ctx.db, ctx.session.user.id, input.id);
      if (row.status === "done") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Deployment already completed — manage the cluster from DigitalOcean or terraform.",
        });
      }
      return toClientDeployment(
        await cancelClusterDeployment(ctx.db, row, input.doToken),
      );
    }),

  // Acknowledge a terminal deployment: hides it from status and wipes every
  // remaining secret (including the scoped key shown on the success screen).
  dismiss: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const row = await ownedDeployment(ctx.db, ctx.session.user.id, input.id);
      if (!isTerminalStatus(row.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Cancel the in-progress deployment instead.",
        });
      }
      return toClientDeployment(await dismissClusterDeployment(ctx.db, row));
    }),

  // Terraform adoption bundle for the most recent deployment that actually
  // created a cluster. Secret-free, so it stays available after dismissal.
  adoptionBundle: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select()
      .from(clusterDeployment)
      .where(eq(clusterDeployment.userId, ctx.session.user.id))
      .orderBy(desc(clusterDeployment.createdAt))
      .limit(1);
    if (!row?.clusterId) return null;
    return {
      clusterName: row.clusterName,
      ...buildAdoptionBundle({ ...row, clusterId: row.clusterId }),
    };
  }),
});
