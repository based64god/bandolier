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
      modelProvider?: "anthropic" | "bedrock" | "openai" | "gemini";
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
    // model, matching how webhook-triggered agents pick one.
    let model = body.model;
    if (!model) {
      const { models } = await listModelsForUser(db, userId, fullName);
      model = pickDefaultModel(models) ?? undefined;
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
      modelProvider: body.modelProvider,
      modelAuth: body.modelAuth,
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
