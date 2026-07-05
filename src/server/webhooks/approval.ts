import {
  dispatchPendingRun,
  getUnresolvedPendingRun,
  markResolved,
} from "~/server/agents/agent-approval";
import { getRepoBotToken } from "~/server/agents/github-app";
import {
  listCommentReactions,
  postIssueCommentWithFallback,
} from "~/server/agents/github-issues";
import {
  getUserRepoPermission,
  isMaintainerOrHigher,
} from "~/server/agents/repo-permissions";
import { db } from "~/server/db";
import { env } from "~/env";

import { type IssueCommentPayload } from "./types";

// Approval / decline commands a maintainer can reply with to act on a held run.
const APPROVE_COMMANDS = ["/bando approve", "/bando-approve"];
const DECLINE_COMMANDS = ["/bando decline", "/bando-decline", "/bando deny"];
// Reaction contents that count as an approval when placed on the bot's
// approval-request comment (a thumbs-up or a rocket).
const APPROVAL_REACTIONS = new Set(["+1", "rocket", "hooray"]);

/**
 * Dispatches a held run after a maintainer's approval: atomically claims the row
 * (so two racing approvals can't both fire), creates the agent job, and posts a
 * confirmation. No-op if the row was already resolved.
 */
async function approveAndDispatch(
  run: Awaited<ReturnType<typeof getUnresolvedPendingRun>>,
  approverLogin: string,
  botToken: string | null,
): Promise<void> {
  if (!run) return;
  const claimed = await markResolved(db, run.id, "dispatched", approverLogin);
  if (!claimed) return; // already resolved by a concurrent approval

  let jobName: string;
  try {
    jobName = await dispatchPendingRun(run);
  } catch (err) {
    console.error("[bandolier:webhook] failed to dispatch approved run", {
      issue: run.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  console.log("[bandolier:webhook] approved run dispatched", {
    issue: run.issueNumber,
    approver: approverLogin,
    job: jobName,
  });
  if (botToken) {
    const taskUrl = `${env.BETTER_AUTH_URL}/repo/${run.repoFullName}`;
    const body =
      `🤖 Approved by @${approverLogin}. Bando is now working on this issue.\n\n` +
      `[View task on the dashboard](${taskUrl}) (job: \`${jobName}\`)`;
    await postIssueCommentWithFallback(
      [{ token: botToken, source: "app-installation" }],
      run.repoFullName,
      run.issueNumber,
      body,
    );
  }
}

/**
 * Handles an `issue_comment` event for the credential-approval flow. A held run
 * (see handleIssueOpened) is dispatched when a maintainer-or-higher user either
 * replies with `/bando approve` or reacts 👍/🚀 to the bot's approval comment.
 * The comment's text is checked first; if it isn't a command, we re-check the
 * approval comment's reactions (GitHub doesn't deliver reaction webhooks, so any
 * later comment activity on the issue is used as a cheap trigger to poll them).
 *
 * Returns true when the issue has an unresolved held run — the comment then
 * belongs to the approval flow and must not also resume a run.
 */
export async function handleApprovalComment(
  payload: IssueCommentPayload,
): Promise<boolean> {
  if (payload.action !== "created") return false;

  const repoFullName = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const run = await getUnresolvedPendingRun(db, repoFullName, issueNumber);
  if (!run) return false;

  const botToken = await getRepoBotToken(db, repoFullName, Date.now());
  const text = (payload.comment.body ?? "").toLowerCase();
  const isApproveCmd = APPROVE_COMMANDS.some((c) => text.includes(c));
  const isDeclineCmd = DECLINE_COMMANDS.some((c) => text.includes(c));

  // A command in the comment is attributed to its sender — verify their
  // privilege before acting. Ignore the bot's own comments.
  if (isApproveCmd || isDeclineCmd) {
    const permToken = botToken ?? null;
    const permission = permToken
      ? await getUserRepoPermission(
          permToken,
          repoFullName,
          payload.sender.login,
        )
      : "none";
    if (!isMaintainerOrHigher(permission)) {
      console.log(
        "[bandolier:webhook] approval command ignored — sender not a maintainer",
        { issue: issueNumber, sender: payload.sender.login, permission },
      );
      return true;
    }
    if (isDeclineCmd) {
      await markResolved(db, run.id, "declined", payload.sender.login);
      console.log("[bandolier:webhook] held run declined", {
        issue: issueNumber,
        by: payload.sender.login,
      });
      if (botToken) {
        await postIssueCommentWithFallback(
          [{ token: botToken, source: "app-installation" }],
          repoFullName,
          issueNumber,
          `🤖 Declined by @${payload.sender.login}. This run will not be dispatched.`,
        );
      }
      return true;
    }
    await approveAndDispatch(run, payload.sender.login, botToken);
    return true;
  }

  // Not a command — poll reactions on the bot's approval comment for an
  // approving 👍/🚀 from a maintainer. (GitHub sends no reaction webhook, so we
  // piggyback on comment activity to check.)
  if (run.approvalCommentId && botToken) {
    try {
      const reactions = await listCommentReactions(
        botToken,
        repoFullName,
        Number(run.approvalCommentId),
      );
      for (const r of reactions) {
        if (!APPROVAL_REACTIONS.has(r.content) || !r.user) continue;
        const permission = await getUserRepoPermission(
          botToken,
          repoFullName,
          r.user.login,
        );
        if (isMaintainerOrHigher(permission)) {
          await approveAndDispatch(run, r.user.login, botToken);
          return true;
        }
      }
    } catch (err) {
      console.warn("[bandolier:webhook] failed to read approval reactions", {
        issue: issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return true;
}
