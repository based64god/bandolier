import { accountRouter } from "~/server/api/routers/account";
import { agentsRouter } from "~/server/api/routers/agents";
import { apiKeysRouter } from "~/server/api/routers/api-keys";
import { clusterDeployRouter } from "~/server/api/routers/cluster-deploy";
import { modelsRouter } from "~/server/api/routers/models";
import { pushRouter } from "~/server/api/routers/push";
import { reposRouter } from "~/server/api/routers/repos";
import { webhooksRouter } from "~/server/api/routers/webhooks";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

export const appRouter = createTRPCRouter({
  agents: agentsRouter,
  repos: reposRouter,
  account: accountRouter,
  models: modelsRouter,
  webhooks: webhooksRouter,
  apiKeys: apiKeysRouter,
  clusterDeploy: clusterDeployRouter,
  push: pushRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.agents.list();
 */
export const createCaller = createCallerFactory(appRouter);
