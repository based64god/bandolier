import { describe, expect, it } from "vitest";

import {
  buildCiResumeUserMessage,
  buildIssueSystemPrompt,
  buildIssueUserMessage,
  buildResumeSystemPrompt,
  buildResumeUserMessage,
  extractOperatorContext,
  issuePreviewBranch,
  makeIssueBranch,
} from "~/lib/issue-prompt";

describe("issuePreviewBranch", () => {
  it("slugifies the title and prefixes the issue number", () => {
    expect(issuePreviewBranch(42, "Fix the login bug")).toBe(
      "issue-42-fix-the-login-bug",
    );
  });

  it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
    expect(issuePreviewBranch(7, "Add   OAuth!! support")).toBe(
      "issue-7-add-oauth-support",
    );
  });

  it("trims leading and trailing separators from the slug", () => {
    expect(issuePreviewBranch(1, "  !!hello!!  ")).toBe("issue-1-hello");
  });

  it("truncates long titles to 24 chars without a trailing hyphen", () => {
    const branch = issuePreviewBranch(
      9,
      "this is a very long issue title that exceeds the limit",
    );
    const slug = branch.replace("issue-9-", "");
    expect(slug.length).toBeLessThanOrEqual(24);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to 'task' when the title has no usable characters", () => {
    expect(issuePreviewBranch(3, "!!!")).toBe("issue-3-task");
  });
});

describe("makeIssueBranch", () => {
  it("extends the preview branch with a random suffix", () => {
    const branch = makeIssueBranch(42, "Fix the login bug");
    expect(branch).toMatch(/^issue-42-fix-the-login-bug-[a-z0-9]{1,6}$/);
  });

  it("yields different suffixes across calls (collision avoidance)", () => {
    const a = makeIssueBranch(42, "Fix bug");
    const b = makeIssueBranch(42, "Fix bug");
    expect(a).not.toBe(b);
  });
});

describe("buildIssueSystemPrompt", () => {
  const issue = { number: 5, title: "Crash on startup", body: "It crashes." };

  it("embeds the branch and a signed, commit-by-commit instruction, but not the issue body", () => {
    const prompt = buildIssueSystemPrompt(issue, "issue-5-crash");
    expect(prompt).toContain('on branch "issue-5-crash"');
    expect(prompt).toContain("git commit -s");
    expect(prompt).toContain("commit-by-commit");
    expect(prompt).toContain("Do NOT push or open a pull request");
    // The issue body belongs in the user message, not the system prompt.
    expect(prompt).not.toContain("It crashes.");
  });
});

describe("buildIssueUserMessage", () => {
  const issue = { number: 5, title: "Crash on startup", body: "It crashes." };

  it("embeds the issue number, title, and body", () => {
    const message = buildIssueUserMessage(issue, "");
    expect(message).toContain("## Issue #5: Crash on startup");
    expect(message).toContain("It crashes.");
    // The instructional framing belongs in the system prompt.
    expect(message).not.toContain("Do NOT push");
  });

  it("uses a placeholder when the body is empty", () => {
    const message = buildIssueUserMessage({ ...issue, body: "   " }, "");
    expect(message).toContain("(no description provided)");
  });

  it("appends operator context when provided", () => {
    const message = buildIssueUserMessage(issue, "Focus on the parser.");
    expect(message).toContain("## Additional context from the operator");
    expect(message).toContain("Focus on the parser.");
  });

  it("omits the operator-context section when context is blank", () => {
    const message = buildIssueUserMessage(issue, "   ");
    expect(message).not.toContain("Additional context from the operator");
  });
});

describe("extractOperatorContext", () => {
  const issue = { number: 5, title: "Crash on startup", body: "It crashes." };

  it("recovers the operator context from a built message", () => {
    const message = buildIssueUserMessage(issue, "Focus on the parser.");
    expect(extractOperatorContext(message)).toBe("Focus on the parser.");
  });

  it("preserves multi-paragraph operator context verbatim", () => {
    const ctx = "First point.\n\n## A heading they wrote\n\nSecond point.";
    const message = buildIssueUserMessage(issue, ctx);
    expect(extractOperatorContext(message)).toBe(ctx);
  });

  it("returns an empty string when no operator context was appended", () => {
    const message = buildIssueUserMessage(issue, "");
    expect(extractOperatorContext(message)).toBe("");
  });
});

describe("buildResumeSystemPrompt", () => {
  it("frames a continued branch as carrying the parent's work and open PR", () => {
    const prompt = buildResumeSystemPrompt("issue-5-fix-abc123", true);
    expect(prompt).toContain('You are on branch "issue-5-fix-abc123"');
    expect(prompt).toContain("already contains the previous run's commits");
    expect(prompt).toContain("existing pull request");
    expect(prompt).toContain("Do NOT push");
  });

  it("frames a fresh branch like a normal run", () => {
    const prompt = buildResumeSystemPrompt("issue-5-fix-abc123", false);
    expect(prompt).toContain('a fresh branch "issue-5-fix-abc123"');
    expect(prompt).not.toContain("existing pull request");
  });
});

describe("buildResumeUserMessage", () => {
  it("carries the item reference, commenter, and comment", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Please also handle logout.",
    });
    expect(message).toContain("## Follow-up on pull request #42: Add login");
    expect(message).toContain("@octocat commented:");
    expect(message).toContain("Please also handle logout.");
  });

  it("folds earlier thread comments in before the triggering comment", () => {
    const message = buildResumeUserMessage({
      kind: "issue",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Please also handle logout.",
      priorComments: [
        { author: "alice", body: "What about SSO?" },
        { author: "bob", body: "Agreed, and logout too." },
      ],
    });
    expect(message).toContain("Earlier comments in this thread");
    expect(message).toContain("@alice commented:");
    expect(message).toContain("What about SSO?");
    expect(message).toContain("@bob commented:");
    // The trigger still renders as the follow-up, after the divider.
    const dividerIdx = message.indexOf("---");
    expect(dividerIdx).toBeGreaterThan(message.indexOf("What about SSO?"));
    expect(message.indexOf("Please also handle logout.")).toBeGreaterThan(
      dividerIdx,
    );
  });

  it("omits the thread block when there are no prior comments", () => {
    const message = buildResumeUserMessage({
      kind: "issue",
      number: 1,
      title: "Bug",
      commenter: "octocat",
      comment: "fix it",
      priorComments: [],
    });
    expect(message).not.toContain("Earlier comments in this thread");
  });

  it("folds prior comments in ahead of a review comment's anchor", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Still not handled.",
      reviewComment: { path: "src/auth.ts", line: 42 },
      priorComments: [{ author: "bando", body: "This should handle null." }],
    });
    expect(message).toContain("Earlier comments in this thread");
    expect(message).toContain("@bando commented:");
    expect(message).toContain(
      "@octocat left a review comment on `src/auth.ts` line 42:",
    );
  });

  it("uses a placeholder for an empty comment", () => {
    const message = buildResumeUserMessage({
      kind: "issue",
      number: 1,
      title: "Bug",
      commenter: "octocat",
      comment: "   ",
    });
    expect(message).toContain("(empty comment)");
  });

  it("anchors a review comment to a single line and shows its diff hunk", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "This should handle the null case.",
      reviewComment: {
        path: "src/auth.ts",
        line: 42,
        diffHunk: "@@ -40,3 +40,4 @@\n   const u = user;\n+  return u;",
      },
    });
    expect(message).toContain("## Follow-up on pull request #42: Add login");
    expect(message).toContain(
      "@octocat left a review comment on `src/auth.ts` line 42:",
    );
    expect(message).toContain("This should handle the null case.");
    expect(message).toContain("```diff\n@@ -40,3 +40,4 @@");
  });

  it("renders a multi-line review comment as a line range", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Extract this block.",
      reviewComment: { path: "src/auth.ts", line: 44, startLine: 40 },
    });
    expect(message).toContain("`src/auth.ts` lines 40–44");
  });

  it("names only the file when the line can't be mapped", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Outdated, but relevant.",
      reviewComment: { path: "src/auth.ts", line: null },
    });
    expect(message).toContain("review comment on `src/auth.ts`:");
    expect(message).not.toContain(" line");
  });

  it("omits the diff block when there is no hunk", () => {
    const message = buildResumeUserMessage({
      kind: "pull request",
      number: 42,
      title: "Add login",
      commenter: "octocat",
      comment: "Nit.",
      reviewComment: { path: "src/auth.ts", line: 3 },
    });
    expect(message).not.toContain("```diff");
  });
});

describe("buildCiResumeUserMessage", () => {
  it("names the failing pipeline, PR, and links the run", () => {
    const message = buildCiResumeUserMessage({
      prNumber: 42,
      title: "Add login",
      workflowName: "CI",
      runUrl: "https://github.com/o/r/actions/runs/9",
    });
    expect(message).toContain("## CI failed on pull request #42: Add login");
    expect(message).toContain("**CI** pipeline failed");
    expect(message).toContain("https://github.com/o/r/actions/runs/9");
    expect(message).toContain("push a fix");
  });

  it("omits the run link when there is no URL", () => {
    const message = buildCiResumeUserMessage({
      prNumber: 1,
      title: "Bug",
      workflowName: "tests",
      runUrl: null,
    });
    expect(message).not.toContain("Failed run:");
    expect(message).toContain("**tests** pipeline failed");
  });
});
