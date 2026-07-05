import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DoApiError,
  createDoksCluster,
  deleteDoksCluster,
  findDoksClusterByName,
  isDoAuthError,
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
});
