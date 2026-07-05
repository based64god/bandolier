/**
 * Shared GitHub REST plumbing: the standard auth/version headers, a fetch
 * helper with one consistent failure convention, a single `GET /repos` probe,
 * and a bounded TTL map for the module-level caches. Everything under
 * `src/server/agents/github-*` builds on these so the header triple, error
 * handling, and cache-eviction logic live in exactly one place.
 */

/** The auth, media-type, and API-version headers every GitHub REST call sends. */
export function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetches a GitHub REST endpoint with the standard auth/version headers.
 *
 * Throw-vs-null convention: this helper THROWS `Error("GitHub API <status>:
 * <statusText>")` on any non-2xx response and lets transport errors propagate,
 * so it is the single, consistent failure signal. Callers that treat a failure
 * as fatal `await ghFetch(...)` directly; callers that must fail soft (return
 * null / false / a default) wrap it in try/catch. Any per-call header (e.g. a
 * `Content-Type` or an override `Accept`) is merged over the defaults via
 * `init.headers`.
 */
export async function ghFetch(
  url: string | URL,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...ghHeaders(token), ...init.headers },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  return res;
}

/** What a GitHub token can do with a repo, from a single `GET /repos` probe. */
export interface RepoAccess {
  /** Whether the token can see the repo at all (GitHub returns it). */
  accessible: boolean;
  /** Whether the token grants admin on the repo. */
  isAdmin: boolean;
  /** The repo's clone URL — present only when accessible. */
  cloneUrl?: string;
  /** The repo's default branch — present only when accessible. */
  defaultBranch?: string;
}

/**
 * Probes a repo through a GitHub token in one `GET /repos/{repo}` call: whether
 * the token can reach the repo at all, whether it grants admin, and — when
 * reachable — its clone URL and default branch. This is the single source for
 * the "can this user touch this repo's shared resources?" gate, the "is this
 * user a repo admin?" gate, and the clone-URL/default-branch lookup. Fails
 * closed — `{ accessible: false, isAdmin: false }` — on any API or transport
 * error, and never reads the body on a non-2xx response.
 */
export async function getRepoAccess(
  token: string,
  repoFullName: string,
): Promise<RepoAccess> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return { accessible: false, isAdmin: false };
    const repo = (await res.json()) as {
      permissions?: { admin?: boolean };
      clone_url?: string;
      default_branch?: string;
    };
    return {
      accessible: true,
      isAdmin: repo.permissions?.admin === true,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
    };
  } catch {
    return { accessible: false, isAdmin: false };
  }
}

interface TtlEntry<V> {
  value: V;
  /** Epoch ms at which the entry goes stale; `Infinity` for terminal entries. */
  expiresAt: number;
}

/**
 * A Map with per-entry expiry and a bounded size, used to keep long-lived
 * module-level caches from growing without limit. On each write, expired
 * entries are swept and, if the map is still over capacity, the oldest
 * surviving entries are evicted (insertion order — a cheap memory bound, not a
 * true LRU; these are short-TTL hot sets, not working sets). `nowMs` is injected
 * so callers control the clock (production passes `Date.now()`; tests a fake).
 */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, TtlEntry<V>>();

  constructor(private readonly maxSize: number) {}

  /** The stored value if present and still fresh at `nowMs`, else undefined. */
  get(key: K, nowMs: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) return undefined;
    return entry.value;
  }

  /** The raw entry regardless of freshness — for stale-fallback reads. */
  peek(key: K): TtlEntry<V> | undefined {
    return this.entries.get(key);
  }

  /**
   * Stores `value` under `key`, going stale at `expiresAt` (default: never).
   * Sweeps expired entries and enforces the size bound on the way in.
   */
  set(key: K, value: V, nowMs: number, expiresAt = Infinity): void {
    this.sweep(nowMs);
    // Re-insert so a refreshed key counts as the newest for eviction order.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
  }
}
