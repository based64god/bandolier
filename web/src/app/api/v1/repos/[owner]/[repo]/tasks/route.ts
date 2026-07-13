import { type NextRequest, NextResponse } from "next/server";

import type { EFFORT_LEVELS } from "~/lib/effort";
import { listModelsForUser, pickDefaultModel } from "~/server/agents/models";
import { resolve, restHandler, toTaskResource } from "~/server/api/rest";
import { db } from "~/server/db";

type Params = { params: Promise<{ owner: string; repo: string }> };

// GET /api/v1/repos/{owner}/{repo}/tasks — list this repo's tasks.
export const GET = restHandler(async (req: NextRequest, { params }: Params) => {
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const ctx = await resolve(req, fullName);
  if ("error" in ctx) return ctx.error;

  const tasks = await ctx.caller.agents.list({
    namespace: ctx.namespace,
    repoFullName: fullName,
  });
  return NextResponse.json({ tasks: tasks.map(toTaskResource) });
});

// POST /api/v1/repos/{owner}/{repo}/tasks — create (deploy) a task.
export const POST = restHandler(
  async (req: NextRequest, { params }: Params) => {
    const { owner, repo } = await params;
    const fullName = `${owner}/${repo}`;
    const ctx = await resolve(req, fullName);
    if ("error" in ctx) return ctx.error;
    const { access, userId } = ctx;

    let body: {
      task?: string;
      prompt?: string;
      branch?: string;
      model?: string;
      // A gollm-proxied provider rides as "gollm:<catalog id>"; omit it and the
      // provider is derived from the model below.
      modelProvider?:
        | "anthropic"
        | "bedrock"
        | "openai"
        | "gemini"
        | `gollm:${string}`;
      modelAuth?: "api_key" | "subscription";
      effort?: (typeof EFFORT_LEVELS)[number];
      maxTurns?: number;
      cpu?: string;
      memory?: string;
      issueNumber?: number;
      outputType?: "pr" | "issue";
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // `model` is optional over REST: default to the user's provider's preferred
    // model, matching how webhook-triggered agents pick one. An empty/whitespace
    // model counts as unset.
    let model = body.model?.trim() ? body.model : undefined;
    let modelProvider = body.modelProvider;
    let modelAuth = body.modelAuth;
    // Resolve the model list when we must pick a default, or to derive the
    // provider of the picked model when the client didn't name one — the
    // "provider follows the model" rule the webhook path uses. Without it a
    // gollm model id with no provider falls through to a first-class provider's
    // credentials and the run fails. Skipped when the client is explicit.
    if (!model || !modelProvider) {
      const { models } = await listModelsForUser(db, userId, fullName);
      model ??= pickDefaultModel(models);
      if (model && !modelProvider) {
        const picked = models.find(
          (m) =>
            m.id === model &&
            (modelAuth === undefined ||
              m.auth === undefined ||
              m.auth === modelAuth),
        );
        if (picked) {
          modelProvider = picked.provider;
          modelAuth ??= picked.auth;
        }
      }
    }
    if (!model) {
      return NextResponse.json(
        {
          error: "No model specified and no default available for your account",
        },
        { status: 400 },
      );
    }

    const { jobName } = await ctx.caller.agents.deploy({
      namespace: ctx.namespace,
      task: body.task ?? body.prompt ?? "",
      repoUrl: access.cloneUrl,
      repoFullName: fullName,
      branch: body.branch ?? access.defaultBranch,
      model,
      modelProvider,
      modelAuth,
      effort: body.effort,
      maxTurns: body.maxTurns,
      cpu: body.cpu,
      memory: body.memory,
      issueNumber: body.issueNumber,
      outputType: body.outputType,
    });
    return NextResponse.json({ id: jobName, jobName }, { status: 201 });
  },
);
