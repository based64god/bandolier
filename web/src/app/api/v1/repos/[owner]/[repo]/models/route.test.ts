import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive the route hermetically: stub the shared REST setup so `resolve` yields
// a fake caller and `restHandler` passes through, leaving only the route's own
// logic (call models.list, shape the response) under test.
const resolve = vi.fn();
const list = vi.fn();
vi.mock("~/server/api/rest", () => ({
  restHandler: (fn: (...a: unknown[]) => Promise<NextResponse>) => fn,
  resolve: (...a: unknown[]): unknown => resolve(...(a as [])),
}));

const { GET } = await import(
  "~/app/api/v1/repos/[owner]/[repo]/models/route"
);

const params = { params: Promise.resolve({ owner: "o", repo: "r" }) };
const req = () => new NextRequest("http://localhost/api/v1/repos/o/r/models");

beforeEach(() => {
  resolve.mockReset();
  list.mockReset();
});

describe("GET /api/v1/repos/{owner}/{repo}/models", () => {
  it("returns the caller's models, repo-scoped", async () => {
    const models = [
      { id: "claude-sonnet-4-5", label: "Sonnet", provider: "anthropic" },
      { id: "llama-3.3-70b", label: "Llama", provider: "gollm:groq" },
    ];
    list.mockResolvedValue({ models });
    resolve.mockResolvedValue({ caller: { models: { list } } });

    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models });
    expect(list).toHaveBeenCalledWith({ repoFullName: "o/r" });
  });

  it("propagates the auth/access error response from resolve", async () => {
    resolve.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await GET(req(), params);
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});
