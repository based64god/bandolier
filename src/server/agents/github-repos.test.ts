import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAccessibleRepos,
  isRepoAdmin,
  userHasRepoAccess,
} from "~/server/agents/github-repos";

// A raw GitHub API repo, defaulted to a minimal public one.
function rawRepo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "acme/widgets",
    description: null,
    private: false,
    html_url: "https://github.com/acme/widgets",
    default_branch: "main",
    clone_url: "https://github.com/acme/widgets.git",
    ...overrides,
  };
}

/** A full page (100 repos), unique per page so batches are traceable. */
function fullPage(page: number) {
  return Array.from({ length: 100 }, (_, i) =>
    rawRepo({ full_name: `acme/repo-${page}-${i}` }),
  );
}

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  };
}

function stubFetch(mock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchAccessibleRepos", () => {
  it("maps raw GitHub repos to the AccessibleRepo shape", async () => {
    stubFetch(
      vi.fn().mockResolvedValue(
        ok([
          rawRepo({
            full_name: "Acme/My Repo",
            description: "d",
            private: true,
            clone_url: "https://github.com/Acme/My%20Repo.git",
            default_branch: "main",
            permissions: { admin: true },
          }),
        ]),
      ),
    );
    expect(await fetchAccessibleRepos("gho_tok")).toEqual([
      {
        fullName: "Acme/My Repo",
        description: "d",
        private: true,
        cloneUrl: "https://github.com/Acme/My%20Repo.git",
        defaultBranch: "main",
        namespace: "acme-my-repo",
        isAdmin: true,
      },
    ]);
  });

  it("treats admin as false unless permissions.admin is exactly true", async () => {
    stubFetch(
      vi.fn().mockResolvedValue(
        ok([
          rawRepo({ full_name: "acme/a" }), // permissions absent entirely
          rawRepo({ full_name: "acme/b", permissions: {} }),
          rawRepo({ full_name: "acme/c", permissions: { admin: false } }),
        ]),
      ),
    );
    const repos = await fetchAccessibleRepos("gho_tok");
    expect(repos.map((r) => r.isAdmin)).toEqual([false, false, false]);
  });

  it("requests every affiliation and visibility, sorted by update, 100 at a time", async () => {
    const fetchMock = stubFetch(vi.fn().mockResolvedValue(ok([])));
    await fetchAccessibleRepos("gho_tok");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://api.github.com/user/repos");
    expect(url.searchParams.get("visibility")).toBe("all");
    expect(url.searchParams.get("affiliation")).toBe(
      "owner,collaborator,organization_member",
    );
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("page")).toBe("1");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gho_tok",
    );
  });

  it("stops after one request when the batch is short of a full page", async () => {
    const fetchMock = stubFetch(
      vi.fn().mockResolvedValue(ok([rawRepo(), rawRepo()])),
    );
    expect(await fetchAccessibleRepos("gho_tok")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the next page until a short batch signals the end", async () => {
    const fetchMock = stubFetch(
      vi
        .fn()
        .mockResolvedValueOnce(ok(fullPage(1)))
        .mockResolvedValueOnce(ok([rawRepo({ full_name: "acme/last" })])),
    );
    const repos = await fetchAccessibleRepos("gho_tok");
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)?.fullName).toBe("acme/last");
    const pages = fetchMock.mock.calls.map((c) =>
      (c[0] as URL).searchParams.get("page"),
    );
    expect(pages).toEqual(["1", "2"]);
  });

  it("stops at the 10-page safety cap even when every page is full", async () => {
    const fetchMock = stubFetch(
      vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(ok(fullPage(Number(url.searchParams.get("page"))))),
        ),
    );
    const repos = await fetchAccessibleRepos("gho_tok");
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(repos).toHaveLength(1000);
  });

  it("throws with the GitHub status on an error response", async () => {
    stubFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: () => Promise.resolve({}),
      }),
    );
    await expect(fetchAccessibleRepos("gho_tok")).rejects.toThrow(
      "GitHub API 403: Forbidden",
    );
  });
});

describe("userHasRepoAccess", () => {
  it("is true when GitHub returns the repo for the token", async () => {
    const fetchMock = stubFetch(vi.fn().mockResolvedValue(ok({})));
    expect(await userHasRepoAccess("gho_tok", "acme/widgets")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gho_tok",
    );
  });

  it("is false when the repo is not visible to the token", async () => {
    stubFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({}),
      }),
    );
    expect(await userHasRepoAccess("gho_tok", "acme/private")).toBe(false);
  });

  it("fails closed when the lookup itself fails", async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error("network down")));
    expect(await userHasRepoAccess("gho_tok", "acme/widgets")).toBe(false);
  });
});

describe("isRepoAdmin", () => {
  function mockFetchOnce(body: unknown, isOk = true, status = 200) {
    const json = vi.fn(() => Promise.resolve(body));
    const fetchMock = stubFetch(
      vi.fn().mockResolvedValue({
        ok: isOk,
        status,
        statusText: isOk ? "OK" : "Error",
        json,
      }),
    );
    return { fetchMock, json };
  }

  it("is true for an admin, asking GitHub with the user's token", async () => {
    const { fetchMock } = mockFetchOnce({ permissions: { admin: true } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });

  it("is false when admin is false", async () => {
    mockFetchOnce({ permissions: { admin: false } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("is false when the body has no permissions at all", async () => {
    mockFetchOnce({});
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("is false when admin is truthy but not boolean true", async () => {
    mockFetchOnce({ permissions: { admin: 1 } });
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("fails closed on an API error without reading the body", async () => {
    const { json } = mockFetchOnce({}, false, 404);
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("fails closed when fetch throws", async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error("network")));
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });

  it("fails closed when the body is not valid JSON", async () => {
    stubFetch(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(new Error("malformed body")),
      }),
    );
    expect(await isRepoAdmin("tok", "o/r")).toBe(false);
  });
});
