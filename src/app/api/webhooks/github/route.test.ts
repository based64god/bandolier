import crypto from "crypto";

import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route reads env.GITHUB_WEBHOOK_SECRET at request time, so back the mock
// with a mutable object each test can rewrite to drive the "no secret" path.
// vi.hoisted keeps the object available to the hoisted vi.mock factory.
const envState = vi.hoisted(
  (): { GITHUB_WEBHOOK_SECRET: string | undefined } => ({
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  }),
);
vi.mock("~/env", () => ({ env: envState }));

// Every I/O boundary the route dispatches to is mocked; the POST handler under
// test only orchestrates signature checks, JSON parsing, and dispatch — the
// handlers' own behavior is out of scope here. Factories defer through arrows
// to dodge vi.mock hoisting TDZ.
const handleApprovalComment = vi.fn<() => Promise<boolean>>();
vi.mock("~/server/webhooks/approval", () => ({
  handleApprovalComment: (...args: unknown[]) =>
    handleApprovalComment(...(args as [])),
}));

const handleIssueComment = vi.fn<() => Promise<void>>();
vi.mock("~/server/webhooks/issue-comment", () => ({
  handleIssueComment: (...args: unknown[]) =>
    handleIssueComment(...(args as [])),
}));

const handleIssueOpened = vi.fn<() => Promise<void>>();
const handleIssueEdited = vi.fn<() => Promise<void>>();
vi.mock("~/server/webhooks/issue-opened", () => ({
  handleIssueOpened: (...args: unknown[]) => handleIssueOpened(...(args as [])),
  handleIssueEdited: (...args: unknown[]) => handleIssueEdited(...(args as [])),
}));

const handleCiFailure = vi.fn<() => Promise<void>>();
vi.mock("~/server/webhooks/ci-failure", () => ({
  handleCiFailure: (...args: unknown[]) => handleCiFailure(...(args as [])),
}));

const handleInstallation = vi.fn<() => Promise<void>>();
vi.mock("~/server/webhooks/installation", () => ({
  handleInstallation: (...args: unknown[]) => handleInstallation(...(args as [])),
}));

const getRepoWebhookConfig = vi.fn<() => Promise<unknown>>();
vi.mock("~/server/agents/webhook-config", () => ({
  getRepoWebhookConfig: (...args: unknown[]) =>
    getRepoWebhookConfig(...(args as [])),
}));

vi.mock("~/server/db", () => ({ db: {} }));

import { POST } from "./route";

const SECRET = "test-webhook-secret";

function sign(rawBody: string, secret: string): string {
  return `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
}

// Minimal NextRequest stand-in: the route only ever calls req.text() and
// req.headers.get(). Header lookups are case-insensitive, mirroring Headers.
function makeReq(
  rawBody: string,
  headers: Record<string, string | null>,
): NextRequest {
  const lower: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    text: () => Promise.resolve(rawBody),
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const REPO = { full_name: "acme/widgets" };

function body(payload: Record<string, unknown>): string {
  return JSON.stringify({ repository: REPO, ...payload });
}

// Post a well-formed payload with a correct signature for the given event.
function signedReq(event: string, payload: Record<string, unknown>) {
  const raw = body(payload);
  return makeReq(raw, {
    "x-github-event": event,
    "x-hub-signature-256": sign(raw, SECRET),
  });
}

beforeEach(() => {
  envState.GITHUB_WEBHOOK_SECRET = SECRET;
  handleApprovalComment.mockResolvedValue(false);
  handleIssueComment.mockResolvedValue(undefined);
  handleIssueOpened.mockResolvedValue(undefined);
  handleIssueEdited.mockResolvedValue(undefined);
  handleCiFailure.mockResolvedValue(undefined);
  handleInstallation.mockResolvedValue(undefined);
  getRepoWebhookConfig.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/webhooks/github signature verification", () => {
  it("accepts a payload whose sha256 signature matches the raw body", async () => {
    const res = await POST(signedReq("issues", { action: "ignored" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a signature computed over a different body", async () => {
    const raw = body({ action: "opened" });
    const res = await POST(
      makeReq(raw, {
        "x-github-event": "issues",
        "x-hub-signature-256": sign(body({ action: "tampered" }), SECRET),
      }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Invalid signature" });
    expect(handleIssueOpened).not.toHaveBeenCalled();
  });

  it("rejects a request with no signature header", async () => {
    const raw = body({ action: "opened" });
    const res = await POST(makeReq(raw, { "x-github-event": "issues" }));
    expect(res.status).toBe(401);
    expect(handleIssueOpened).not.toHaveBeenCalled();
  });

  it("rejects a signature whose byte length differs from the expected digest", async () => {
    // A too-short signature makes timingSafeEqual throw on the length mismatch;
    // the catch must convert that into a plain rejection, not a 500.
    const raw = body({ action: "opened" });
    const res = await POST(
      makeReq(raw, {
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=deadbeef",
      }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Invalid signature" });
  });
});

describe("POST /api/webhooks/github configuration + parsing guards", () => {
  it("returns 503 and dispatches nothing when no secret is configured", async () => {
    envState.GITHUB_WEBHOOK_SECRET = undefined;
    const raw = body({ action: "opened" });
    const res = await POST(
      makeReq(raw, {
        "x-github-event": "issues",
        "x-hub-signature-256": sign(raw, SECRET),
      }),
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Webhook not configured",
    });
    expect(handleIssueOpened).not.toHaveBeenCalled();
    expect(getRepoWebhookConfig).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed JSON body", async () => {
    const res = await POST(
      makeReq("{not json", { "x-github-event": "issues" }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(handleIssueOpened).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github event dispatch", () => {
  it("routes an issues.opened event to handleIssueOpened", async () => {
    const res = await POST(signedReq("issues", { action: "opened" }));
    expect(res.status).toBe(200);
    expect(handleIssueOpened).toHaveBeenCalledTimes(1);
  });

  it("routes an issues.edited event to handleIssueEdited", async () => {
    const res = await POST(signedReq("issues", { action: "edited" }));
    expect(res.status).toBe(200);
    expect(handleIssueEdited).toHaveBeenCalledTimes(1);
  });

  it("returns 500 (not an unhandled rejection) when a handler throws", async () => {
    handleIssueOpened.mockRejectedValue(new Error("boom"));
    const res = await POST(signedReq("issues", { action: "opened" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal error" });
  });
});

describe("POST /api/webhooks/github approval short-circuit", () => {
  const commentPayload = {
    action: "created",
    comment: { id: 1, body: "approve", user: { id: 2, login: "alice" } },
    issue: {},
  };

  it("does not resume a run when the comment is consumed as an approval", async () => {
    handleApprovalComment.mockResolvedValue(true);
    const res = await POST(signedReq("issue_comment", commentPayload));
    expect(res.status).toBe(200);
    expect(handleApprovalComment).toHaveBeenCalledTimes(1);
    expect(handleIssueComment).not.toHaveBeenCalled();
  });

  it("resumes a run when the comment is not an approval", async () => {
    handleApprovalComment.mockResolvedValue(false);
    const res = await POST(signedReq("issue_comment", commentPayload));
    expect(res.status).toBe(200);
    expect(handleApprovalComment).toHaveBeenCalledTimes(1);
    expect(handleIssueComment).toHaveBeenCalledTimes(1);
  });
});
