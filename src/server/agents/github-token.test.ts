import { describe, expect, it } from "vitest";

import { githubGitIdentity } from "~/server/agents/github-token";

describe("githubGitIdentity", () => {
  it("uses the login as the git name", () => {
    expect(githubGitIdentity(12345, "octocat").name).toBe("octocat");
  });

  it("builds the GitHub no-reply email from id and login", () => {
    expect(githubGitIdentity(12345, "octocat").email).toBe(
      "12345+octocat@users.noreply.github.com",
    );
  });

  it("accepts a string id (webhook sender ids arrive as numbers, deploy as strings)", () => {
    expect(githubGitIdentity("67890", "monalisa").email).toBe(
      "67890+monalisa@users.noreply.github.com",
    );
  });
});
