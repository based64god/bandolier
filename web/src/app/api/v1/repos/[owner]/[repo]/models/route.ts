import { type NextRequest, NextResponse } from "next/server";

import { resolve, restHandler } from "~/server/api/rest";

type Params = { params: Promise<{ owner: string; repo: string }> };

// GET /api/v1/repos/{owner}/{repo}/models — list the models the caller can
// launch a task with. Drawn from every provider they have credentials for —
// the four first-class providers plus every gollm-proxied provider — with each
// model's `provider` (a `gollm:<id>` for the proxied ones) and `auth`, so a
// client knows exactly what to pass as `model` / `modelProvider` / `modelAuth`
// on POST .../tasks. Repo-scoped, so the repo's shared credentials count per
// its prefer-credentials flag.
export const GET = restHandler(async (req: NextRequest, { params }: Params) => {
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const ctx = await resolve(req, fullName);
  if ("error" in ctx) return ctx.error;

  const { models } = await ctx.caller.models.list({ repoFullName: fullName });
  return NextResponse.json({ models });
});
