// Minimal DigitalOcean REST client for one-click agent-cluster deploys: the
// API-call equivalent of the resources deploy/terraform/digitalocean creates
// with agent_only=true (a DOKS cluster and a bucket-scoped Spaces key; the
// bucket itself goes through the S3-compatible API, not this client).
//
// Every function takes the user's API token per call — tokens are one-shot
// credentials held on a deployment row only while it is active, never a
// stored user credential.

const DO_API_BASE = "https://api.digitalocean.com";

/** A DigitalOcean API failure. `status` lets callers distinguish bad
 * credentials (401/403 → fail the deployment) from transient errors (retry on
 * the next poll). */
export class DoApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DoApiError";
    this.status = status;
  }
}

async function doFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${DO_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `DigitalOcean API error (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new DoApiError(res.status, message);
  }
  return res;
}

/** True when the error means the token itself is bad — not worth retrying. */
export function isDoAuthError(err: unknown): boolean {
  return (
    err instanceof DoApiError && (err.status === 401 || err.status === 403)
  );
}

/** True when retrying can't help: auth failures and 4xx request/validation
 * errors (e.g. 422 "droplet limit exceeded"). Excludes 408/429, which are
 * timing problems the next poll may well not hit. */
export function isDoPermanentError(err: unknown): boolean {
  return (
    err instanceof DoApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

// ── Kubernetes (DOKS) ─────────────────────────────────────────────────────────

export interface DoksCluster {
  id: string;
  name: string;
  version: string;
  endpoint: string;
  state: string;
}

interface RawCluster {
  id: string;
  name: string;
  version: string;
  endpoint: string;
  status: { state: string };
}

function toCluster(raw: RawCluster): DoksCluster {
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    endpoint: raw.endpoint,
    state: raw.status.state,
  };
}

/** Latest available DOKS version slug — the API-call analogue of the
 * digitalocean_kubernetes_versions data source's latest_version. */
export async function latestDoksVersion(token: string): Promise<string> {
  const res = await doFetch(token, "/v2/kubernetes/options");
  const body = (await res.json()) as {
    options: { versions: { slug: string; kubernetes_version: string }[] };
  };
  const versions = body.options.versions;
  if (!versions.length)
    throw new DoApiError(500, "DigitalOcean returned no Kubernetes versions.");
  const numeric = (v: { kubernetes_version: string }) =>
    v.kubernetes_version.split(".").map(Number);
  const sorted = [...versions].sort((a, b) => {
    const [aMaj = 0, aMin = 0, aPatch = 0] = numeric(a);
    const [bMaj = 0, bMin = 0, bPatch = 0] = numeric(b);
    return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
  });
  return sorted[0]!.slug;
}

export interface CreateDoksClusterOptions {
  name: string;
  region: string;
  version: string;
  nodeSize: string;
  minNodes: number;
  maxNodes: number;
  haControlPlane: boolean;
}

/** Create the agent cluster; mirrors cluster.tf (auto/surge upgrade, one
 * autoscaling pool named "default"). */
export async function createDoksCluster(
  token: string,
  opts: CreateDoksClusterOptions,
): Promise<DoksCluster> {
  const res = await doFetch(token, "/v2/kubernetes/clusters", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      region: opts.region,
      version: opts.version,
      auto_upgrade: true,
      surge_upgrade: true,
      ha: opts.haControlPlane,
      node_pools: [
        {
          name: "default",
          size: opts.nodeSize,
          count: opts.minNodes,
          auto_scale: true,
          min_nodes: opts.minNodes,
          max_nodes: opts.maxNodes,
          // The DO terraform provider requires this tag to import a cluster.
          // It auto-tags single-pool clusters at import time, but stamping it
          // here makes the adoption bundle work even if a pool is added later.
          tags: ["terraform:default-node-pool"],
        },
      ],
    }),
  });
  const body = (await res.json()) as { kubernetes_cluster: RawCluster };
  return toCluster(body.kubernetes_cluster);
}

/** Look up a cluster by name — the idempotency handle for the create step
 * (DOKS names are unique per account, so a re-tick adopts rather than
 * duplicates). */
export async function findDoksClusterByName(
  token: string,
  name: string,
): Promise<DoksCluster | null> {
  const res = await doFetch(token, "/v2/kubernetes/clusters?per_page=200");
  const body = (await res.json()) as {
    kubernetes_clusters?: RawCluster[] | null;
  };
  const match = (body.kubernetes_clusters ?? []).find((c) => c.name === name);
  return match ? toCluster(match) : null;
}

export async function getDoksCluster(
  token: string,
  clusterId: string,
): Promise<DoksCluster> {
  const res = await doFetch(token, `/v2/kubernetes/clusters/${clusterId}`);
  const body = (await res.json()) as { kubernetes_cluster: RawCluster };
  return toCluster(body.kubernetes_cluster);
}

/** The DO-issued admin kubeconfig (short-lived token — bootstrap only; the
 * long-lived ServiceAccount kubeconfig is what gets saved). */
export async function getDoksKubeconfig(
  token: string,
  clusterId: string,
): Promise<string> {
  const res = await doFetch(
    token,
    `/v2/kubernetes/clusters/${clusterId}/kubeconfig`,
  );
  return res.text();
}

export async function deleteDoksCluster(
  token: string,
  clusterId: string,
): Promise<void> {
  try {
    await doFetch(token, `/v2/kubernetes/clusters/${clusterId}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (err instanceof DoApiError && err.status === 404) return;
    throw err;
  }
}

// ── Spaces keys ───────────────────────────────────────────────────────────────
// The bucket-scoped access key the app hands the user for per-repo artifact
// storage; mirrors digitalocean_spaces_key.artifacts (readwrite on one bucket).

export interface SpacesKey {
  name: string;
  accessKey: string;
  secretKey: string;
}

interface RawSpacesKey {
  name: string;
  access_key: string;
  secret_key?: string;
}

export async function createScopedSpacesKey(
  token: string,
  opts: { name: string; bucket: string },
): Promise<SpacesKey> {
  const res = await doFetch(token, "/v2/spaces/keys", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      grants: [{ bucket: opts.bucket, permission: "readwrite" }],
    }),
  });
  const body = (await res.json()) as { key: RawSpacesKey };
  return {
    name: body.key.name,
    accessKey: body.key.access_key,
    // Only returned at creation time — callers must persist it immediately.
    secretKey: body.key.secret_key ?? "",
  };
}

/** A temporary full-access key (bucket "" = all buckets, including creation).
 * The Spaces bucket API authenticates with Spaces keys rather than the API
 * token, so bucket creation needs one; the app mints this key itself, uses it
 * once, and deletes it as soon as the bucket-scoped key exists. */
export async function createFullAccessSpacesKey(
  token: string,
  name: string,
): Promise<SpacesKey> {
  const res = await doFetch(token, "/v2/spaces/keys", {
    method: "POST",
    body: JSON.stringify({
      name,
      grants: [{ bucket: "", permission: "fullaccess" }],
    }),
  });
  const body = (await res.json()) as { key: RawSpacesKey };
  return {
    name: body.key.name,
    accessKey: body.key.access_key,
    secretKey: body.key.secret_key ?? "",
  };
}

/** Find a key by name. The API never returns secrets for existing keys, so a
 * re-entrant create step deletes any same-named key and mints a fresh one.
 * DO answers 404 for an EMPTY key list (observed in the wild), so 404 means
 * "no keys", not an error. */
export async function findSpacesKeyByName(
  token: string,
  name: string,
): Promise<{ name: string; accessKey: string } | null> {
  let res: Response;
  try {
    res = await doFetch(token, "/v2/spaces/keys?per_page=200");
  } catch (err) {
    if (err instanceof DoApiError && err.status === 404) return null;
    throw err;
  }
  const body = (await res.json()) as { keys?: RawSpacesKey[] | null };
  const match = (body.keys ?? []).find((k) => k.name === name);
  return match ? { name: match.name, accessKey: match.access_key } : null;
}

export async function deleteSpacesKey(
  token: string,
  accessKey: string,
): Promise<void> {
  try {
    await doFetch(token, `/v2/spaces/keys/${accessKey}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof DoApiError && err.status === 404) return;
    throw err;
  }
}

/** How many more droplets the account can create: its droplet limit minus the
 * droplets already running. DOKS worker nodes are droplets, so an autoscale
 * max above this is guaranteed to be rejected with a validation error —
 * checked pre-flight so the user hears it at submit time, not mid-deploy. */
export async function getDropletCapacity(
  token: string,
): Promise<{ limit: number; inUse: number; available: number }> {
  const [accountRes, dropletsRes] = await Promise.all([
    doFetch(token, "/v2/account"),
    doFetch(token, "/v2/droplets?per_page=1"),
  ]);
  const account = (await accountRes.json()) as {
    account: { droplet_limit: number };
  };
  const droplets = (await dropletsRes.json()) as {
    meta?: { total?: number };
  };
  const limit = account.account.droplet_limit;
  const inUse = droplets.meta?.total ?? 0;
  return { limit, inUse, available: Math.max(0, limit - inUse) };
}

/** Cheap token probe for pre-flight validation (GET /v2/account). */
export async function validateDoToken(
  token: string,
  opts?: { spaces?: boolean },
): Promise<{ valid: true } | { valid: false; error: string }> {
  // Probe every read surface the deploy flow depends on, not just the token's
  // validity: DigitalOcean's custom-scoped tokens answer 404 (not 403) for
  // resources they can't read, so a token missing kubernetes/spaces read
  // scopes would create a cluster and then be unable to see it — a failure
  // mode far better caught here, at submit time.
  const probes: { label: string; path: string }[] = [
    { label: "account", path: "/v2/account" },
    {
      label: "Kubernetes clusters",
      path: "/v2/kubernetes/clusters?per_page=1",
    },
    { label: "droplets", path: "/v2/droplets?per_page=1" },
    ...(opts?.spaces === false
      ? []
      : [{ label: "Spaces keys", path: "/v2/spaces/keys?per_page=1" }]),
  ];
  const results = await Promise.all(
    probes.map(async (probe) => {
      try {
        await doFetch(token, probe.path);
        return null;
      } catch (err) {
        return { probe, err };
      }
    }),
  );
  // DO 404s the Spaces key list when it is merely EMPTY (observed in the
  // wild), so a 404 there is not evidence of a problem. If key creation
  // truly is unavailable, the deploy degrades to kubeconfig-only later
  // rather than being blocked here.
  const meaningful = (
    results.filter(Boolean) as { probe: { label: string }; err: unknown }[]
  ).filter(
    ({ probe, err }) =>
      !(
        probe.label === "Spaces keys" &&
        err instanceof DoApiError &&
        err.status === 404
      ),
  );
  if (!meaningful.length) return { valid: true };

  if (meaningful.some(({ err }) => isDoAuthError(err)))
    return { valid: false, error: "DigitalOcean API token is invalid." };
  const missing = meaningful
    .filter(({ err }) => isDoPermanentError(err))
    .map(({ probe }) => probe.label);
  if (missing.length) {
    return {
      valid: false,
      error:
        `This token can't read: ${missing.join(", ")}. ` +
        "Custom-scoped tokens hide resources they can't access — create the token with Full Access.",
    };
  }
  const first = meaningful[0]!.err;
  return {
    valid: false,
    error:
      first instanceof Error ? first.message : "Could not reach DigitalOcean.",
  };
}
