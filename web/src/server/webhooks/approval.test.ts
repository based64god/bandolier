import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingRun } from "~/server/agents/agent-approval";
import type { CommentReaction } from "~/server/agents/github-issues";
import type * as RepoPermissions from "~/server/agents/repo-permissions";
import type { RepoPermission } from "~/server/agents/repo-permissions";

import { type ApprovalComment } from "./approval";

// The approval handler is a thin policy layer over four collaborators — the
// pending-run store, the bot-token broker, GitHub comment/reaction I/O, and the
// permission lookup. All four are mocked so the tests assert exactly which of
// them fire (dispatch vs. decline vs. ignore) for each maintainer-gate outcome.
// `isMaintainerOrHigher` is a pure ranking function, so the real one is kept.
const dispatchPendingRun = vi.fn<(run: PendingRun) => Promise<string>>();
const getUnresolvedPendingRun = vi.fn<() => Promise<PendingRun | null>>();
const markResolved =
  vi.fn<
    (
      db: unknown,
      id: string,
      resolution: string,
      by: string,
    ) => Promise<boolean>
  >();
vi.mock("~/server/agents/agent-approval", () => ({
  dispatchPendingRun: (run: PendingRun) => dispatchPendingRun(run),
  getUnresolvedPendingRun: () => getUnresolvedPendingRun(),
  markResolved: (db: unknown, id: string, resolution: string, by: string) =>
    markResolved(db, id, resolution, by),
}));

const getRepoBotToken = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-app", () => ({
  getRepoBotToken: () => getRepoBotToken(),
}));

const listCommentReactions = vi.fn<() => Promise<CommentReaction[]>>();
const postIssueCommentWithFallback = vi.fn<() => Promise<string | null>>();
vi.mock("~/server/agents/github-issues", () => ({
  listCommentReactions: () => listCommentReactions(),
  postIssueCommentWithFallback: () => postIssueCommentWithFallback(),
}));

const getUserRepoPermission = vi.fn<() => Promise<RepoPermission>>();
vi.mock("~/server/agents/repo-permissions", async () => {
  const actual = await vi.importActual<typeof RepoPermissions>(
    "~/server/agents/repo-permissions",
  );
  return {
    isMaintainerOrHigher: actual.isMaintainerOrHigher,
    getUserRepoPermission: () => getUserRepoPermission(),
  };
});

vi.mock("~/server/db", () => ({ db: { __brand: "db" } }));
vi.mock("~/env", () => ({ env: { BETTER_AUTH_URL: "http://test.local" } }));

const { handleApprovalComment } = await import("./approval");

const run: PendingRun = {
  id: "run-1",
  repoFullName: "o/r",
  issueNumber: 12,
  requestedByLogin: "newcomer",
  approvalCommentId: null,
  spec: {
    task: "Fix it",
    displayName: "Fix it",
    branch: "main",
    model: "claude-sonnet-4-5",
    issueNumber: "12",
    userId: "u1",
    kubeconfig: "kc",
  },
};

function comment(body: string | null, sender = "maintainer"): ApprovalComment {
  return {
    action: "created",
    repoFullName: "o/r",
    itemNumber: 12,
    commentBody: body,
    sender: { login: sender },
  };
}

beforeEach(() => {
  dispatchPendingRun.mockReset().mockResolvedValue("job-abc");
  getUnresolvedPendingRun.mockReset().mockResolvedValue(run);
  markResolved.mockReset().mockResolvedValue(true);
  getRepoBotToken.mockReset().mockResolvedValue("bot-tok");
  listCommentReactions.mockReset().mockResolvedValue([]);
  postIssueCommentWithFallback
    .mockReset()
    .mockResolvedValue("app-installation");
  getUserRepoPermission.mockReset().mockResolvedValue("maintain");
});

describe("handleApprovalComment", () => {
  it("ignores a non-created action without touching the store", async () => {
    const payload = comment("/bando approve");
    payload.action = "edited";
    expect(await handleApprovalComment(payload)).toBe(false);
    expect(getUnresolvedPendingRun).not.toHaveBeenCalled();
  });

  it("returns false when the issue has no unresolved held run", async () => {
    getUnresolvedPendingRun.mockResolvedValue(null);
    expect(await handleApprovalComment(comment("/bando approve"))).toBe(false);
    expect(markResolved).not.toHaveBeenCalled();
    expect(dispatchPendingRun).not.toHaveBeenCalled();
  });

  describe("approve command", () => {
    it("claims the run and dispatches for a maintainer", async () => {
      getUserRepoPermission.mockResolvedValue("maintain");
      expect(await handleApprovalComment(comment("/bando approve"))).toBe(true);

      expect(markResolved).toHaveBeenCalledWith(
        expect.anything(),
        "run-1",
        "dispatched",
        "maintainer",
      );
      expect(dispatchPendingRun).toHaveBeenCalledTimes(1);
    });

    it("ignores a non-maintainer but still consumes the comment (returns true)", async () => {
      getUserRepoPermission.mockResolvedValue("write");
      expect(
        await handleApprovalComment(comment("/bando approve", "dev")),
      ).toBe(true);

      expect(markResolved).not.toHaveBeenCalled();
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("fails closed when there is no bot token (permission treated as none)", async () => {
      getRepoBotToken.mockResolvedValue(null);
      // A permission lookup that would return "maintain" must never even run —
      // with no token the sender is denied before the API is consulted.
      getUserRepoPermission.mockResolvedValue("admin");

      expect(await handleApprovalComment(comment("/bando approve"))).toBe(true);
      expect(getUserRepoPermission).not.toHaveBeenCalled();
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("does not double-dispatch when markResolved loses the race (returns false)", async () => {
      markResolved.mockResolvedValue(false);
      expect(await handleApprovalComment(comment("/bando approve"))).toBe(true);

      expect(markResolved).toHaveBeenCalledTimes(1);
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });
  });

  describe("decline command", () => {
    it("declines and never dispatches for a maintainer", async () => {
      expect(await handleApprovalComment(comment("/bando decline"))).toBe(true);

      expect(markResolved).toHaveBeenCalledWith(
        expect.anything(),
        "run-1",
        "declined",
        "maintainer",
      );
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("wins over approve when a comment contains both commands", async () => {
      const both = "/bando decline — actually no, /bando approve";
      expect(await handleApprovalComment(comment(both))).toBe(true);

      // Decline is checked first, so the run is resolved "declined", not
      // dispatched, even though the approve text is also present.
      expect(markResolved).toHaveBeenCalledWith(
        expect.anything(),
        "run-1",
        "declined",
        "maintainer",
      );
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("ignores a decline from a non-maintainer", async () => {
      getUserRepoPermission.mockResolvedValue("read");
      expect(
        await handleApprovalComment(comment("/bando decline", "dev")),
      ).toBe(true);
      expect(markResolved).not.toHaveBeenCalled();
    });
  });

  describe("reaction path", () => {
    const withReactionComment = () => {
      const payload = comment("thanks, looks good");
      getUnresolvedPendingRun.mockResolvedValue({
        ...run,
        approvalCommentId: "c-9",
      });
      return payload;
    };

    it("dispatches on a maintainer's 🚀 reaction on the approval comment", async () => {
      const payload = withReactionComment();
      listCommentReactions.mockResolvedValue([
        { content: "rocket", user: { login: "boss" } },
      ]);
      getUserRepoPermission.mockResolvedValue("admin");

      expect(await handleApprovalComment(payload)).toBe(true);
      expect(markResolved).toHaveBeenCalledWith(
        expect.anything(),
        "run-1",
        "dispatched",
        "boss",
      );
      expect(dispatchPendingRun).toHaveBeenCalledTimes(1);
    });

    it("does not dispatch for a non-maintainer's reaction", async () => {
      const payload = withReactionComment();
      listCommentReactions.mockResolvedValue([
        { content: "+1", user: { login: "dev" } },
      ]);
      getUserRepoPermission.mockResolvedValue("write");

      expect(await handleApprovalComment(payload)).toBe(true);
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("ignores non-approving reactions and reactions with no user", async () => {
      const payload = withReactionComment();
      listCommentReactions.mockResolvedValue([
        { content: "confused", user: { login: "boss" } },
        { content: "rocket", user: null },
      ]);
      getUserRepoPermission.mockResolvedValue("admin");

      expect(await handleApprovalComment(payload)).toBe(true);
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("does not poll reactions when the run has no approval comment id", async () => {
      const payload = comment("just a normal comment");
      expect(await handleApprovalComment(payload)).toBe(true);
      expect(listCommentReactions).not.toHaveBeenCalled();
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });

    it("swallows a reaction-read failure and still consumes the comment", async () => {
      const payload = withReactionComment();
      listCommentReactions.mockRejectedValue(new Error("boom"));
      expect(await handleApprovalComment(payload)).toBe(true);
      expect(dispatchPendingRun).not.toHaveBeenCalled();
    });
  });
});
