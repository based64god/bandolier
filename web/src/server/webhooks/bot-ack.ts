import { getRepoBotToken } from "~/server/agents/github-app";
import { postIssueCommentWithFallback } from "~/server/agents/github-issues";
import { db } from "~/server/db";

/**
 * Posts a bot-voice acknowledgement ("🤖 Bando …") on an issue or PR. Bot-voice
 * comments must only ever be posted by the bot itself — exclusively the GitHub
 * App installation token, attributed to bandolier[bot]. We deliberately do NOT
 * fall back to the legacy service-user PAT or the triggering user's OAuth token:
 * a comment that speaks in the bot's voice but is attributed to a human (or a
 * generic service user) is misleading. On a repo with no App installation
 * there's no bot identity to comment as, so the comment is skipped rather than
 * posted under another credential.
 *
 * Returns the source that posted the comment ("app-installation"), or null when
 * no usable token could post it.
 */
export async function postBotAck(
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<string | null> {
  const botToken = await getRepoBotToken(db, repoFullName, Date.now());
  return postIssueCommentWithFallback(
    [{ token: botToken, source: "app-installation" }],
    repoFullName,
    issueNumber,
    body,
  );
}
