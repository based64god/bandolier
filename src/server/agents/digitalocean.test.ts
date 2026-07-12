import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DoApiError,
  createDoksCluster,
  createFullAccessSpacesKey,
  createScopedSpacesKey,
  deleteDoksCluster,
  deleteSpacesKey,
  findDoksClusterByName,
  findSpacesKeyByName,
  getDoksCluster,
  getDoksKubeconfig,
  getDropletCapacity,
  isDoAuthError,
  isDoPermanentError,
  latestDoksVersion,
  validateDoToken,
} from "~/server/agents/digitalocean";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

// A response with a raw (non-JSON) text body — the kubeconfig endpoint returns
// YAML, and DO's gateway can return HTML on 5xx (json() rejects there).
function textResponse(text: string, status = 200) {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new Error("Unexpected token < in JSON")),
  };
}

describe("latestDoksVersion", () => {
  it("sorts numerically instead of trusting API order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          options: {
            versions: [
              { slug: "1.9.1-do.2", kubernetes_version: "1.9.1" },
              { slug: "1.32.2-do.0", kubernetes_version: "1.32.2" },
              { slug: "1.32.10-do.1", kubernetes_version: "1.32.10" },
              { slug: "1.31.9-do.5", kubernetes_version: "1.31.9" },
            ],
          },
        }),
      ),
    );
    await expect(latestDoksVersion("t")).resolves.toBe("1.32.10-do.1");
  });
});

describe("createDoksCluster", () => {
  it("mirrors cluster.tf: auto/surge upgrade, one autoscaling default pool, import tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        kubernetes_cluster: {
          id: "c-1",
          name: "bandolier-abc123",
          version: "1.32.2-do.0",
          endpoint: "",
          status: { state: "provisioning" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cluster = await createDoksCluster("dop_v1_t", {
      name: "bandolier-abc123",
      region: "nyc3",
      version: "1.32.2-do.0",
      nodeSize: "s-4vcpu-8gb",
      minNodes: 1,
      maxNodes: 4,
      haControlPlane: false,
    });
    expect(cluster.id).toBe("c-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/kubernetes/clusters");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer dop_v1_t",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.auto_upgrade).toBe(true);
    expect(body.surge_upgrade).toBe(true);
    expect(body.ha).toBe(false);
    expect(body.node_pools).toEqual([
      {
        name: "default",
        size: "s-4vcpu-8gb",
        count: 1,
        auto_scale: true,
        min_nodes: 1,
        max_nodes: 4,
        tags: ["terraform:default-node-pool"],
      },
    ]);
  });
});

describe("getDropletCapacity", () => {
  it("derives remaining capacity from the account limit and droplets in use", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/v2/account")
              ? jsonResponse({ account: { droplet_limit: 3 } })
              : jsonResponse({ meta: { total: 1 } }),
          ),
        ),
    );
    await expect(getDropletCapacity("t")).resolves.toEqual({
      limit: 3,
      inUse: 1,
      available: 2,
    });
  });

  it("never reports negative capacity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/v2/account")
              ? jsonResponse({ account: { droplet_limit: 3 } })
              : jsonResponse({ meta: { total: 5 } }),
          ),
        ),
    );
    await expect(getDropletCapacity("t")).resolves.toMatchObject({
      available: 0,
    });
  });
});

describe("error handling", () => {
  it("maps API failures to DoApiError with the response message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: "Unable to authenticate you" }, 401),
        ),
    );
    const err = await findDoksClusterByName("bad", "x").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DoApiError);
    expect((err as DoApiError).status).toBe(401);
    expect(isDoAuthError(err)).toBe(true);
    expect(isDoAuthError(new DoApiError(500, "boom"))).toBe(false);
  });

  it("classifies permanent vs transient failures", () => {
    // 4xx request/validation errors repeat identically — fail the deployment.
    expect(isDoPermanentError(new DoApiError(422, "droplet limit"))).toBe(true);
    expect(isDoPermanentError(new DoApiError(401, "bad token"))).toBe(true);
    // Timing problems and server errors are worth the next poll's retry.
    expect(isDoPermanentError(new DoApiError(429, "rate limited"))).toBe(false);
    expect(isDoPermanentError(new DoApiError(408, "timeout"))).toBe(false);
    expect(isDoPermanentError(new DoApiError(500, "server error"))).toBe(false);
    expect(isDoPermanentError(new Error("network"))).toBe(false);
  });

  it("treats 404 on delete as already gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "not found" }, 404)),
    );
    await expect(deleteDoksCluster("t", "c-1")).resolves.toBeUndefined();
  });

  it("validateDoToken distinguishes bad tokens from unreachable API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "nope" }, 401)),
    );
    await expect(validateDoToken("bad")).resolves.toEqual({
      valid: false,
      error: "DigitalOcean API token is invalid.",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(validateDoToken("t")).resolves.toEqual({
      valid: false,
      error: "ECONNRESET",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ account: {} })),
    );
    await expect(validateDoToken("t")).resolves.toEqual({ valid: true });
  });

  it("names the read scopes a custom-scoped token is missing", async () => {
    // DO answers 404 (not 403) for resources a scoped token can't read.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/v2/kubernetes")
              ? jsonResponse({ message: "Not Found" }, 404)
              : jsonResponse({ account: {} }),
          ),
        ),
    );
    const result = await validateDoToken("scoped");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Kubernetes clusters");
      expect(result.error).toContain("Full Access");
    }
  });

  it("tolerates a 404 on the Spaces key list — DO 404s an empty collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/v2/spaces")
              ? jsonResponse({ message: "Not Found" }, 404)
              : jsonResponse({ account: {} }),
          ),
        ),
    );
    await expect(validateDoToken("t")).resolves.toEqual({ valid: true });
  });

  it("findSpacesKeyByName treats the empty-list 404 as no keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "Not Found" }, 404)),
    );
    await expect(findSpacesKeyByName("t", "any")).resolves.toBeNull();
  });

  it("skips the Spaces probe when spaces is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ account: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateDoToken("t", { spaces: false })).resolves.toEqual({
      valid: true,
    });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/v2/spaces/keys"))).toBe(false);
  });

  it("falls back to the generic message when the error body is not JSON", async () => {
    // DO's gateway can answer 5xx with an HTML page; json() rejects, so doFetch
    // must keep its synthetic "HTTP <status>" message rather than blow up.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse("<html>Bad Gateway</html>", 502)),
    );
    const err = await getDoksCluster("t", "c-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoApiError);
    expect((err as DoApiError).status).toBe(502);
    expect((err as DoApiError).message).toBe(
      "DigitalOcean API error (HTTP 502).",
    );
  });
});

const rawCluster = {
  id: "c-1",
  name: "bandolier-abc123",
  version: "1.32.2-do.0",
  endpoint: "https://c-1.k8s.ondigitalocean.com",
  status: { state: "running" },
};

const mappedCluster = {
  id: "c-1",
  name: "bandolier-abc123",
  version: "1.32.2-do.0",
  endpoint: "https://c-1.k8s.ondigitalocean.com",
  state: "running",
};

describe("findDoksClusterByName", () => {
  it("returns the name-matched cluster mapped through toCluster", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        kubernetes_clusters: [
          { ...rawCluster, id: "c-0", name: "other" },
          rawCluster,
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      findDoksClusterByName("t", "bandolier-abc123"),
    ).resolves.toEqual(mappedCluster);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.digitalocean.com/v2/kubernetes/clusters?per_page=200",
    );
  });

  it("returns null when no cluster has the given name", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ kubernetes_clusters: [rawCluster] })),
    );
    await expect(findDoksClusterByName("t", "nonexistent")).resolves.toBeNull();
  });

  it("tolerates a null kubernetes_clusters field", async () => {
    // The list endpoint has been seen returning null instead of [] when empty.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ kubernetes_clusters: null })),
    );
    await expect(findDoksClusterByName("t", "anything")).resolves.toBeNull();
  });
});

describe("getDoksCluster", () => {
  it("fetches one cluster by id and maps its status into state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kubernetes_cluster: rawCluster }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDoksCluster("t", "c-1")).resolves.toEqual(mappedCluster);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.digitalocean.com/v2/kubernetes/clusters/c-1",
    );
  });
});

describe("getDoksKubeconfig", () => {
  it("returns the raw kubeconfig text body from the kubeconfig endpoint", async () => {
    const kubeconfig = "apiVersion: v1\nkind: Config\n";
    const fetchMock = vi.fn().mockResolvedValue(textResponse(kubeconfig));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDoksKubeconfig("t", "c-1")).resolves.toBe(kubeconfig);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.digitalocean.com/v2/kubernetes/clusters/c-1/kubeconfig",
    );
  });
});

describe("deleteDoksCluster", () => {
  it("rethrows non-404 DoApiErrors instead of swallowing them", async () => {
    // A 500 on delete is a real failure the caller must see and retry.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, 500)),
    );
    const err = await deleteDoksCluster("t", "c-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoApiError);
    expect((err as DoApiError).status).toBe(500);
  });
});

describe("createScopedSpacesKey", () => {
  it("POSTs a readwrite grant scoped to the one bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        key: {
          name: "bandolier-artifacts",
          access_key: "DO00ACCESS",
          secret_key: "s3cr3t",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createScopedSpacesKey("t", {
        name: "bandolier-artifacts",
        bucket: "bandolier-abc123",
      }),
    ).resolves.toEqual({
      name: "bandolier-artifacts",
      accessKey: "DO00ACCESS",
      secretKey: "s3cr3t",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/spaces/keys");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      name: "bandolier-artifacts",
      grants: [{ bucket: "bandolier-abc123", permission: "readwrite" }],
    });
  });

  it("defaults secretKey to '' when the API omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          key: { name: "k", access_key: "DO00ACCESS" },
        }),
      ),
    );
    await expect(
      createScopedSpacesKey("t", { name: "k", bucket: "b" }),
    ).resolves.toEqual({ name: "k", accessKey: "DO00ACCESS", secretKey: "" });
  });
});

describe("createFullAccessSpacesKey", () => {
  it("POSTs a fullaccess grant on bucket '' (all buckets)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        key: {
          name: "bootstrap",
          access_key: "DO00FULL",
          secret_key: "topsecret",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createFullAccessSpacesKey("t", "bootstrap")).resolves.toEqual({
      name: "bootstrap",
      accessKey: "DO00FULL",
      secretKey: "topsecret",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/spaces/keys");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      name: "bootstrap",
      grants: [{ bucket: "", permission: "fullaccess" }],
    });
  });
});

describe("findSpacesKeyByName", () => {
  it("returns the matched key mapping access_key onto accessKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        keys: [
          { name: "other", access_key: "DO00OTHER" },
          { name: "wanted", access_key: "DO00WANTED", secret_key: "hidden" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // The list endpoint never returns secrets, so only name + accessKey survive.
    await expect(findSpacesKeyByName("t", "wanted")).resolves.toEqual({
      name: "wanted",
      accessKey: "DO00WANTED",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.digitalocean.com/v2/spaces/keys?per_page=200",
    );
  });

  it("returns null when the list has no name match", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ keys: [{ name: "other", access_key: "DO00OTHER" }] }),
        ),
    );
    await expect(findSpacesKeyByName("t", "wanted")).resolves.toBeNull();
  });

  it("rethrows non-404 DoApiErrors from the list call", async () => {
    // Only the empty-list 404 is swallowed; a 500 is a genuine failure.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, 500)),
    );
    const err = await findSpacesKeyByName("t", "wanted").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DoApiError);
    expect((err as DoApiError).status).toBe(500);
  });
});

describe("deleteSpacesKey", () => {
  it("DELETEs the key by access key and swallows a 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteSpacesKey("t", "DO00ACCESS")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/spaces/keys/DO00ACCESS");
    expect(init.method).toBe("DELETE");
  });

  it("rethrows non-404 DoApiErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, 500)),
    );
    const err = await deleteSpacesKey("t", "DO00ACCESS").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DoApiError);
    expect((err as DoApiError).status).toBe(500);
  });
});
