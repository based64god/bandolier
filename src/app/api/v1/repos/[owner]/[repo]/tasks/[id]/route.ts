import { type NextRequest, NextResponse } from "next/server";

import { resolve, restHandler, toTaskResource } from "~/server/api/rest";

type Params = {
  params: Promise<{ owner: string; repo: string; id: string }>;
};

// GET /api/v1/repos/{owner}/{repo}/tasks/{id} — read one task.
export const GET = restHandler(async (req: NextRequest, { params }: Params) => {
  const { owner, repo, id } = await params;
  const ctx = await resolve(req, `${owner}/${repo}`);
  if ("error" in ctx) return ctx.error;

  const task = await ctx.caller.agents.get({
    namespace: ctx.namespace,
    jobName: id,
    repoFullName: ctx.fullName,
  });
  return NextResponse.json(toTaskResource(task));
});

// PATCH /api/v1/repos/{owner}/{repo}/tasks/{id} — update a task's display name.
export const PATCH = restHandler(
  async (req: NextRequest, { params }: Params) => {
    const { owner, repo, id } = await params;
    const ctx = await resolve(req, `${owner}/${repo}`);
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

    await ctx.caller.agents.rename({
      namespace: ctx.namespace,
      jobName: id,
      displayName,
      repoFullName: ctx.fullName,
    });
    const task = await ctx.caller.agents.get({
      namespace: ctx.namespace,
      jobName: id,
      repoFullName: ctx.fullName,
    });
    return NextResponse.json(toTaskResource(task));
  },
);

// DELETE /api/v1/repos/{owner}/{repo}/tasks/{id} — terminate a task.
export const DELETE = restHandler(
  async (req: NextRequest, { params }: Params) => {
    const { owner, repo, id } = await params;
    const ctx = await resolve(req, `${owner}/${repo}`);
    if ("error" in ctx) return ctx.error;

    const task = await ctx.caller.agents.get({
      namespace: ctx.namespace,
      jobName: id,
      repoFullName: ctx.fullName,
    });
    await ctx.caller.agents.terminate({
      podName: task.name,
      namespace: ctx.namespace,
      repoFullName: ctx.fullName,
    });
    return NextResponse.json({ success: true });
  },
);