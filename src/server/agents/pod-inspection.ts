import { parseTokenUsageFromLogs, type TokenUsage } from "~/lib/tokens";
import { getCoreV1Api } from "~/server/k8s/client";

const PR_MARKER = /PR_URL=(https:\/\/\S+)/;
// The harness logs this when an issue-output run opens its GitHub issue.
const ISSUE_MARKER = /ISSUE_URL=(https:\/\/\S+)/;
// Harness log markers bracketing an interactive turn: it prints AWAIT when it
// starts waiting for the next user message and RESUME when one arrives. The most
// recent of the two tells us whether the agent is currently awaiting input.
const AWAIT_MARKER = "BANDOLIER_AWAIT_INPUT";
const RESUME_MARKER = "BANDOLIER_RESUME";
// Tags transcript lines carrying a user's interactive message. Kept in sync with
// the harness (userInputMarker) and the dashboard's log renderer.
const USER_MARKER = "[user]";

export interface PodInspection {
  /** The most recent assistant (non-harness) line — what Claude is doing now. */
  currently: string | null;
  /** The pull-request URL the harness logged, if any. */
  pullRequestUrl: string | null;
  /** The URL of the issue an issue-output run created, if any. */
  createdIssueUrl: string | null;
  /** True when an interactive agent is currently waiting for user input. */
  awaitingInput: boolean;
  /**
   * The run's token usage, parsed from the harness's most recent token marker
   * in the logs. Null when no marker is present (run hasn't reported yet, or a
   * provider that doesn't report tokens).
   */
  tokens: TokenUsage | null;
}

// Pod inspections are cached. Terminal pods' logs are immutable, so those
// entries never expire. Running pods get a TTL just under the dashboard's 5s
// poll — every poll still re-reads the logs so "currently" stays live, but
// concurrent viewers of the same pods (repo collaborators, multiple tabs,
// overview + list) coalesce onto one log read per pod instead of one each.
// The in-flight promise is what's cached, so simultaneous calls share a
// single read rather than racing past an empty cache.
const RUNNING_INSPECTION_TTL_MS = 3_000;
const inspectionCache = new Map<
  string,
  { inspection: Promise<PodInspection>; freshUntil: number }
>();

/** The uncached log read behind inspectPod. Rejects on any read failure. */
async function readPodInspection(
  podName: string,
  namespace: string,
  terminal: boolean,
  kubeconfig: string,
): Promise<PodInspection> {
  const logs = await getCoreV1Api(kubeconfig).readNamespacedPodLog({
    name: podName,
    namespace,
    tailLines: 200,
  });

  const lines = logs.split("\n").map((l) => l.trim());

  // Forward pass: the last AWAIT/RESUME marker decides the awaiting state.
  let lastAwait = -1;
  let lastResume = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(AWAIT_MARKER)) lastAwait = i;
    if (lines[i]!.includes(RESUME_MARKER)) lastResume = i;
  }

  // Backward pass: the last assistant line is what Claude is doing now. Skip
  // both harness diagnostics and the user's own messages — neither is Claude.
  let currently: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line && !line.includes("[harness]") && !line.includes(USER_MARKER)) {
      currently = line;
      break;
    }
  }

  return {
    currently,
    pullRequestUrl: PR_MARKER.exec(logs)?.[1] ?? null,
    createdIssueUrl: ISSUE_MARKER.exec(logs)?.[1] ?? null,
    awaitingInput: !terminal && lastAwait >= 0 && lastAwait > lastResume,
    tokens: parseTokenUsageFromLogs(logs),
  };
}

/**
 * Reads a pod's recent logs once to derive both its live "currently" status (the
 * last assistant line) and any pull-request URL the harness produced.
 */
export async function inspectPod(
  podName: string,
  namespace: string,
  phase: string,
  kubeconfig: string,
): Promise<PodInspection> {
  const terminal = phase === "Succeeded" || phase === "Failed";
  // Phase class is part of the key so a pod that just finished gets one fresh
  // terminal read instead of being served its cached running-phase inspection.
  const runningKey = `${namespace}/${podName}/running`;
  const key = terminal ? `${namespace}/${podName}/terminal` : runningKey;
  const cached = inspectionCache.get(key);
  if (cached && cached.freshUntil > Date.now()) return cached.inspection;

  const inspection: Promise<PodInspection> = readPodInspection(
    podName,
    namespace,
    terminal,
    kubeconfig,
  ).catch((): PodInspection => {
    // transient; evict so the next poll retries the read instead of being
    // served this empty fallback for the rest of the TTL. (A .catch callback
    // runs on a microtask, so `inspection` is always assigned by now.)
    if (inspectionCache.get(key)?.inspection === inspection) {
      inspectionCache.delete(key);
    }
    return {
      currently: null,
      pullRequestUrl: null,
      createdIssueUrl: null,
      awaitingInput: false,
      tokens: null,
    };
  });

  inspectionCache.set(key, {
    inspection,
    freshUntil: terminal ? Infinity : Date.now() + RUNNING_INSPECTION_TTL_MS,
  });
  // A terminal pod no longer needs its running-phase entry.
  if (terminal) inspectionCache.delete(runningKey);
  return inspection;
}
