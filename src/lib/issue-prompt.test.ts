import { describe, expect, it } from "vitest";

import {
  buildIssuePrompt,
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

describe("buildIssuePrompt", () => {
  const issue = { number: 5, title: "Crash on startup", body: "It crashes." };

  it("embeds the issue number, title, body, and branch", () => {
    const prompt = buildIssuePrompt(issue, "issue-5-crash", "");
    expect(prompt).toContain("GitHub issue #5");
    expect(prompt).toContain("## Issue #5: Crash on startup");
    expect(prompt).toContain("It crashes.");
    expect(prompt).toContain('on branch "issue-5-crash"');
  });

  it("uses a placeholder when the body is empty", () => {
    const prompt = buildIssuePrompt(
      { ...issue, body: "   " },
      "issue-5-crash",
      "",
    );
    expect(prompt).toContain("(no description provided)");
  });

  it("appends operator context when provided", () => {
    const prompt = buildIssuePrompt(issue, "br", "Focus on the parser.");
    expect(prompt).toContain("## Additional context from the operator");
    expect(prompt).toContain("Focus on the parser.");
  });

  it("omits the operator-context section when context is blank", () => {
    const prompt = buildIssuePrompt(issue, "br", "   ");
    expect(prompt).not.toContain("Additional context from the operator");
  });
});
