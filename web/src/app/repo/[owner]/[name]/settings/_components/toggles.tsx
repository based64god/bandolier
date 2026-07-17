"use client";

import { api } from "~/trpc/react";
import { ToggleSection } from "~/app/dashboard/_components/credential-ui";

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
  // Resumes are seeded with the parent run's persisted transcript, so the
  // feature needs the repo's artifact store; the server rejects enabling
  // without one. Only block turning it ON — a repo whose store was removed
  // after enabling must still be able to switch it off.
  const hasArtifactStore = config?.hasArtifactStore ?? false;
  const blockedOnArtifacts = !hasArtifactStore && !enabled;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-purple-300">
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
            disabled={setResume.isPending || blockedOnArtifacts}
            onChange={(v) => setResume.mutate({ repoFullName, enabled: v })}
            accent="purple"
            switchAriaLabel="Resume tasks on CI failure"
          />
          {blockedOnArtifacts && (
            <p className="text-xs text-white/40">
              Requires artifact storage: resumed runs are seeded with the parent
              run&apos;s stored transcript. Configure the repo&apos;s artifact
              store (S3 bucket + keys) below first.
            </p>
          )}
          {setResume.error && (
            <p className="text-xs text-red-400">{setResume.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// PR reviews: when a pull request is opened (or marked ready for review),
// Bandolier posts an automatic bot-voice code review. A later push to the PR
// branch re-reviews the changes. Off by default, admin-only. Needs the repo's
// artifact store (a re-review resumes the review run from its stored transcript).
export function RepoReviewSection({ repoFullName }: { repoFullName: string }) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setReview = api.webhooks.setReviewPullRequests.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  const enabled = config?.reviewPullRequests ?? false;
  // Re-reviews resume the review run from its persisted transcript, so the
  // feature needs the artifact store; the server rejects enabling without one.
  // Only block turning it ON, so a repo whose store was removed can still turn
  // it off.
  const hasArtifactStore = config?.hasArtifactStore ?? false;
  const blockedOnArtifacts = !hasArtifactStore && !enabled;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-purple-300">
          Review pull requests
        </h3>
        <p className="text-xs text-white/40">
          When a pull request is opened (or marked ready for review), post an
          automatic code review. The review is attributed to the Bandolier bot,
          never to a user. A later push to the PR&apos;s branch re-reviews the
          changes; replies to a review comment resume the run that opened the PR.
        </p>
      </div>
      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <ToggleSection
            label="Auto-review opened pull requests"
            description="Runs on the PR author's model credentials; the review itself is posted in the bot voice."
            enabled={enabled}
            disabled={setReview.isPending || blockedOnArtifacts}
            onChange={(v) => setReview.mutate({ repoFullName, enabled: v })}
            accent="purple"
            switchAriaLabel="Review pull requests"
          />
          {blockedOnArtifacts && (
            <p className="text-xs text-white/40">
              Requires artifact storage: a push to the PR branch re-reviews by
              resuming the review run from its stored transcript. Configure the
              repo&apos;s artifact store (S3 bucket + keys) below first.
            </p>
          )}
          {setReview.error && (
            <p className="text-xs text-red-400">{setReview.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
