// Issue labels of the form `<prefix><value>` let the author configure that
// issue's agent per issue:
//   - `model:<query>`  — fuzzy-resolved against the available models.
//   - `effort:<level>` — reasoning effort (low|medium|high|xhigh|max); Claude
//                        runs only, ignored otherwise.
//   - `cpu:<qty>` / `memory:<qty>` — the agent pod's compute limits, as
//                        Kubernetes quantities (e.g. cpu:4, memory:8Gi).
export const MODEL_LABEL_PREFIX = "model:";
export const EFFORT_LABEL_PREFIX = "effort:";
export const CPU_LABEL_PREFIX = "cpu:";
export const MEMORY_LABEL_PREFIX = "memory:";

/** The value of the first label carrying the given prefix, or null. */
export function labelQuery(
  labels: { name: string }[],
  prefix: string,
): string | null {
  for (const l of labels) {
    const name = l.name.trim();
    if (name.toLowerCase().startsWith(prefix)) {
      const q = name.slice(prefix.length).trim();
      if (q) return q;
    }
  }
  return null;
}

// An `output:issue` label makes the agent produce sub-task issues instead of a
// pull request: the harness analyses the issue and opens a child issue for the
// most valuable next piece of work.
const OUTPUT_ISSUE_LABEL = "output:issue";

export function wantsIssueOutput(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name.trim().toLowerCase() === OUTPUT_ISSUE_LABEL);
}
