import { type NextRequest, NextResponse } from "next/server";

import type { EFFORT_LEVELS } from "~/lib/effort";
import { listModelsForUser, pickDefaultModel } from "~/server/agents/models";
import { repoToNamespace } from "~/server/agents/namespace";
import {
  authenticate,
  callerForUser,
  errorMessage,
  getAccessibleRepo,
  statusForTrpcError,
  toTaskResource,
} from "~/server/api/rest";
import { db } from "~/server/db";

type Params = { params: Promise<{ owner: string; repo: string }> };

// GET /api/v1/repos/{owner}/{repo}/tasks — list this repo's tasks.
export async function GET(req: NextRequest, { params }: Params) {
  const userId = await authenticate(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  if (!(await getAccessibleRepo(userId, fullName))) {
    return NextResponse.json(
      { error: "Repository not found or not accessible" },
      { status: 403 },
    );
  }

  const caller = await callerForUser(userId);
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tasks = await caller.agents.list({
      namespace: repoToNamespace(fullName),
      repoFullName: fullName,
    });
    return NextResponse.json({ tasks: tasks.map(toTaskResource) });
  } catch (err) {
    return NextResponse.json(
      { error: errorMessage(err) },
      { status: statusForTrpcError(err) },
    );
  }
}

// POST /api/v1/repos/{owner}/{repo}/tasks — create (deploy) a task.
export async function POST(req: NextRequest, { params }: Params) {
  const userId = await authenticate(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const access = await getAccessibleRepo(userId, fullName);
  if (!access) {
    return NextResponse.json(
      { error: "Repository not found or not accessible" },
      { status: 403 },
    );
  }

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
      { error: "No model specified and no default available for your account" },
      { status: 400 },
    );
  }

  const caller = await callerForUser(userId);
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { jobName } = await caller.agents.deploy({
      namespace: repoToNamespace(fullName),
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
  } catch (err) {
    return NextResponse.json(
      { error: errorMessage(err) },
      { status: statusForTrpcError(err) },
    );
  }
}
