import { describe, expect, it } from "vitest";

import { repoToNamespace } from "~/server/agents/namespace";

describe("repoToNamespace", () => {
  it("converts owner/repo to a hyphenated name", () => {
    expect(repoToNamespace("owner/my-repo")).toBe("owner-my-repo");
  });

  it("lowercases uppercase characters", () => {
    expect(repoToNamespace("Acme/MyRepo")).toBe("acme-myrepo");
  });

  it("collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(repoToNamespace("a..b//c")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", () => {
    expect(repoToNamespace("_owner_/_repo_")).toBe("owner-repo");
  });

  it("truncates to at most 63 characters", () => {
    const long = "a".repeat(40) + "/" + "b".repeat(40);
    expect(repoToNamespace(long).length).toBeLessThanOrEqual(63);
  });

  it("preserves digits", () => {
    expect(repoToNamespace("user123/repo456")).toBe("user123-repo456");
  });
});
