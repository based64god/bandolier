"use client";

import { api } from "~/trpc/react";
import { ToggleSection } from "../credential-ui";

// Resumeable tasks: when CI fails on a PR Bandolier opened, auto-resume the run
// that produced it to investigate and push a fix. Off by default — it spends the
// owner's credentials unattended, bounded server-side (once per commit, capped
// per PR).
export function RepoResumeSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setResume = api.webhooks.setResumeOnCiFailure.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  const enabled = config?.resumeOnCiFailure ?? false;

  return (
    <div className="space-y-3 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Resume tasks on CI failure
        </h3>
        <p className="text-xs text-white/40">
          When CI (a GitHub Actions{" "}
          <code className="rounded bg-white/10 px-1 text-white/60">
            workflow_run
          </code>
          ) fails on a pull request Bandolier opened, resume the run that
          produced it to investigate and push a fix. Only open, same-repo PRs;
          each commit resumes once, and a PR stops after a few attempts.
        </p>
      </div>
      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <ToggleSection
            label="Auto-resume on failing CI"
            description="Runs as the task's owner, on their model and cluster credentials."
            enabled={enabled}
            disabled={setResume.isPending}
            onChange={(v) => setResume.mutate({ repoFullName, enabled: v })}
            accent="purple"
            switchAriaLabel="Resume tasks on CI failure"
          />
          {setResume.error && (
            <p className="text-xs text-red-400">{setResume.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Auto-merge: enable GitHub's native auto-merge on every pull request a Bandolier
// run opens, so it lands once its required checks pass — no human click. Off by
// default. Branch protection still gates the merge, so a repo with none would
// merge immediately.
export function RepoAutoMergeSection({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setAutoMerge = api.webhooks.setAutoMergeBandolierPrs.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  const enabled = config?.autoMergeBandolierPrs ?? false;

  return (
    <div className="space-y-3 border-t border-white/10 pt-5">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
          Auto-merge Bandolier PRs
        </h3>
        <p className="text-xs text-white/40">
          When a Bandolier run opens a pull request, enable GitHub auto-merge on
          it, so it merges once its required checks pass. Branch protection
          (required reviews / status checks) still gates the merge, so a branch
          with none would merge right away. Uses the first of merge / squash /
          rebase the repo permits.
        </p>
      </div>
      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <ToggleSection
            label="Auto-merge on passing checks"
            description="Merges an agent's PR with no human click — enable only if branch protection is a gate you trust."
            enabled={enabled}
            disabled={setAutoMerge.isPending}
            onChange={(v) => setAutoMerge.mutate({ repoFullName, enabled: v })}
            accent="purple"
            switchAriaLabel="Auto-merge Bandolier PRs"
          />
          {setAutoMerge.error && (
            <p className="text-xs text-red-400">{setAutoMerge.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
