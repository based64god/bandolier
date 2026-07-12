// Preloaded into the Next server (NODE_OPTIONS=--import) for the authenticated
// flows. Playwright's page.route can't reach the out-of-process server's own
// fetches, so this intercepts server-side GitHub REST calls by wrapping global
// fetch (ghFetch + getRepoAccess both use it): repos.list and the repo-access
// probes resolve to one canned repo, with no real network. Everything else
// passes through unchanged.
const REPO_FULL = process.env.E2E_GH_REPO ?? "acme/widgets";
const [owner, name] = REPO_FULL.split("/");

const repo = {
  id: 1,
  full_name: REPO_FULL,
  name,
  description: "e2e test repo",
  private: false,
  clone_url: `https://github.com/${REPO_FULL}.git`,
  default_branch: "main",
  owner: { login: owner, id: 1 },
  permissions: { admin: true, push: true, pull: true },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubMock(url) {
  const { pathname } = new URL(url);
  if (pathname === "/user/repos") return jsonResponse([repo]);
  if (pathname === `/repos/${REPO_FULL}`) return jsonResponse(repo);
  if (pathname === "/user") return jsonResponse({ login: owner, id: 1 });
  // The repo's open issues (the deploy modal's issue picker) — none.
  if (pathname === `/repos/${REPO_FULL}/issues`) return jsonResponse([]);
  // Unknown GitHub endpoints → 404 so callers fail soft.
  return jsonResponse({ message: "Not Found" }, 404);
}

// Anthropic model listing (models.list → listAnthropicModels) hits
// GET /v1/models; return a small catalog so the deploy form has a model.
function anthropicMock(url) {
  const { pathname } = new URL(url);
  if (pathname === "/v1/models") {
    return jsonResponse({
      data: [
        { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        { type: "model", id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      ],
      has_more: false,
    });
  }
  return jsonResponse({ type: "error", error: { message: "not found" } }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input?.url ?? String(input));
  if (url.startsWith("https://api.github.com")) return githubMock(url);
  if (url.startsWith("https://api.anthropic.com")) return anthropicMock(url);
  return realFetch(input, init);
};
