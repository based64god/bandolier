import { type NextRequest, NextResponse } from "next/server";

import { repoToNamespace } from "~/server/agents/namespace";
import {
  authenticate,
  callerForUser,
  errorMessage,
  getAccessibleRepo,
  statusForTrpcError,
  toTaskResource,
} from "~/server/api/rest";

type Params = {
  params: Promise<{ owner: string; repo: string; id: string }>;
};

/** Shared setup: authenticate, check repo access, build a caller. */
async function resolve(req: NextRequest, params: Params["params"]) {
  const userId = await authenticate(req);
  if (!userId) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    } as const;
  }

  const { owner, repo, id } = await params;
  const fullName = `${owner}/${repo}`;
  if (!(await getAccessibleRepo(userId, fullName))) {
    return {
      error: NextResponse.json(
        { error: "Repository not found or not accessible" },
        { status: 403 },
      ),
    } as const;
  }

  const caller = await callerForUser(userId);
  if (!caller) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    } as const;
  }

  return {
    caller,
    namespace: repoToNamespace(fullName),
    jobName: id,
    repoFullName: fullName,
  } as const;
}

// GET /api/v1/repos/{owner}/{repo}/tasks/{id} — read one task.
export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await resolve(req, params);
  if ("error" in ctx) return ctx.error;

  try {
    const task = await ctx.caller.agents.get({
      namespace: ctx.namespace,
      jobName: ctx.jobName,
      repoFullName: ctx.repoFullName,
    });
    return NextResponse.json(toTaskResource(task));
  } catch (err) {
    return NextResponse.json(
      { error: errorMessage(err) },
      { status: statusForTrpcError(err) },
    );
  }
}

// PATCH /api/v1/repos/{owner}/{repo}/tasks/{id} — update a task's display name.
export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await resolve(req, params);
  if ("error" in ctx) return ctx.error;

  let body: { displayName?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const displayName = body.displayName ?? body.name;
  if (!displayName) {
    return NextResponse.json(
      { error: "displayName is required" },
      { status: 400 },
    );
  }

  try {
    await ctx.caller.agents.rename({
      namespace: ctx.namespace,
      jobName: ctx.jobName,
      displayName,
      repoFullName: ctx.repoFullName,
    });
    const task = await ctx.caller.agents.get({
      namespace: ctx.namespace,
      jobName: ctx.jobName,
      repoFullName: ctx.repoFullName,
    });
    return NextResponse.json(toTaskResource(task));
  } catch (err) {
    return NextResponse.json(
      { error: errorMessage(err) },
      { status: statusForTrpcError(err) },
    );
  }
}

// DELETE /api/v1/repos/{owner}/{repo}/tasks/{id} — terminate a task.
export async function DELETE(req: NextRequest, { params }: Params) {
  const ctx = await resolve(req, params);
  if ("error" in ctx) return ctx.error;

  try {
    const task = await ctx.caller.agents.get({
      namespace: ctx.namespace,
      jobName: ctx.jobName,
      repoFullName: ctx.repoFullName,
    });
    await ctx.caller.agents.terminate({
      podName: task.name,
      namespace: ctx.namespace,
      repoFullName: ctx.repoFullName,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: errorMessage(err) },
      { status: statusForTrpcError(err) },
    );
  }
}
