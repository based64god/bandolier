"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  CLUSTER_DEPLOY_DEFAULTS,
  CLUSTER_DEPLOY_STEPS,
  DO_NODE_SIZES,
  DO_REGIONS,
  isTerminalStatus,
} from "~/lib/cluster-deploy";
import { api, type RouterOutputs } from "~/trpc/react";
import { SearchableSelect } from "./searchable-select";

type Deployment = NonNullable<RouterOutputs["clusterDeploy"]["status"]>;

const POLL_INTERVAL_MS = 5000;

const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-sky-400/60 focus:outline-none";
const labelClass = "block text-xs text-white/50";

/**
 * One-click DigitalOcean deploy: the UI equivalent of the repo's
 * deploy/terraform/digitalocean setup with agent_only=true. Collects one-shot
 * admin credentials, then drives the server-side state machine by polling
 * `clusterDeploy.tick` until the cluster's ServiceAccount kubeconfig lands in
 * the user's Kubernetes settings.
 */
export function ClusterDeploySection() {
  const utils = api.useUtils();
  const { data: deployment } = api.clusterDeploy.status.useQuery();

  // The user's API token lives ONLY here, in memory — it is never persisted
  // server-side, so every tick/cancel carries it along. A page reload loses
  // it; TokenGate asks for it again before the deployment can keep advancing.
  const [doToken, setDoToken] = useState("");

  const tick = api.clusterDeploy.tick.useMutation({
    onSuccess: (d) => {
      utils.clusterDeploy.status.setData(undefined, d);
      if (d.status === "done") {
        void utils.clusterDeploy.adoptionBundle.invalidate();
      }
    },
  });
  const { mutate: tickMutate } = tick;

  const activeId =
    deployment && !isTerminalStatus(deployment.status) ? deployment.id : null;
  useEffect(() => {
    if (!activeId || !doToken) return;
    // Ticks are idempotent server-side, so an overlap with a slow step is
    // harmless — no in-flight guard needed.
    const interval = setInterval(
      () => tickMutate({ id: activeId, doToken }),
      POLL_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [activeId, doToken, tickMutate]);

  const needsToken =
    !doToken &&
    (activeId !== null || deployment?.status === "failed") &&
    deployment !== null;

  // Presented like the GitHub App install card in repo config: a boxed
  // callout with a prominent CTA on the settings page's infrastructure panel.
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
        Deploy an agent cluster
      </h3>

      {!deployment && <DeployForm onStarted={setDoToken} />}
      {needsToken && <TokenGate onToken={setDoToken} />}
      {deployment && !isTerminalStatus(deployment.status) && (
        <DeployProgress deployment={deployment} doToken={doToken} />
      )}
      {deployment?.status === "done" && (
        <DeploySuccess deployment={deployment} />
      )}
      {deployment?.status === "failed" && (
        <DeployFailure deployment={deployment} doToken={doToken} />
      )}
    </div>
  );
}

/** Re-collects the API token after a reload: the token is never stored, so an
 * in-flight (or failed) deployment can't advance or clean up without the user
 * re-supplying it. Validated with a cheap probe so a typo can't hard-fail the
 * deployment on the next tick. */
function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const check = api.clusterDeploy.checkToken.useMutation({
    onSuccess: (result) => {
      if (result.valid) onToken(value);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        check.mutate({ doToken: value });
      }}
      className="space-y-2"
      data-testid="token-gate"
    >
      <p className="text-xs text-amber-300/80">
        Your API token isn&apos;t stored — re-enter it to keep this deployment
        moving (or to clean it up).
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="dop_v1_…"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={check.isPending || value.trim() === ""}
          className="shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-black hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {check.isPending ? "Checking…" : "Continue"}
        </button>
      </div>
      {check.data?.valid === false && (
        <p className="text-xs text-rose-300/90">{check.data.error}</p>
      )}
      {check.error && (
        <p className="text-xs text-rose-300/90">{check.error.message}</p>
      )}
    </form>
  );
}

function DeployForm({ onStarted }: { onStarted: (token: string) => void }) {
  const utils = api.useUtils();
  const [expanded, setExpanded] = useState(false);

  const [doToken, setDoToken] = useState("");
  const [spacesEnabled, setSpacesEnabled] = useState(true);
  const [haControlPlane, setHaControlPlane] = useState<boolean>(
    CLUSTER_DEPLOY_DEFAULTS.haControlPlane,
  );
  const [region, setRegion] = useState<string>(CLUSTER_DEPLOY_DEFAULTS.region);
  const [nodeSize, setNodeSize] = useState<string>(
    CLUSTER_DEPLOY_DEFAULTS.nodeSize,
  );
  const [minNodes, setMinNodes] = useState<number>(
    CLUSTER_DEPLOY_DEFAULTS.minNodes,
  );
  const [maxNodes, setMaxNodes] = useState<number>(
    CLUSTER_DEPLOY_DEFAULTS.maxNodes,
  );

  const start = api.clusterDeploy.start.useMutation({
    onSuccess: (d) => {
      // Hand the token to the section (memory only) so the ticks can carry
      // it; it is never persisted anywhere.
      onStarted(doToken);
      setDoToken("");
      utils.clusterDeploy.status.setData(undefined, d);
    },
  });

  if (!expanded) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-white/60">
          No cluster yet? Provision a DigitalOcean Kubernetes cluster for your
          agents (plus an artifacts bucket) with one click — all you need is a
          DigitalOcean API token. You get its kubeconfig and storage keys to
          save where you choose, and the resources match the repo&apos;s
          terraform setup, so you can adopt them with terraform later.
        </p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-black hover:bg-sky-500"
        >
          Deploy a cluster…
        </button>
      </div>
    );
  }

  const canSubmit =
    doToken.trim() !== "" && minNodes >= 1 && maxNodes >= minNodes;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate({
      doToken,
      region: region as (typeof DO_REGIONS)[number],
      nodeSize,
      minNodes,
      maxNodes,
      haControlPlane,
      spacesEnabled,
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-xs text-white/40">
        Your API token is used once to create the resources and bootstrap a
        ServiceAccount kubeconfig, then discarded — it is never kept as a stored
        credential. A bucket-scoped storage key is created for you and shown
        once at the end. Costs are billed to your DigitalOcean account (nodes
        from ~$24/mo each, Spaces ~$5/mo).
      </p>
      <div>
        <label className={labelClass} htmlFor="do-token">
          DigitalOcean API token (Full Access — custom-scoped tokens hide
          resources they can&apos;t read)
        </label>
        <input
          id="do-token"
          type="password"
          required
          value={doToken}
          onChange={(e) => setDoToken(e.target.value)}
          placeholder="dop_v1_…"
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={spacesEnabled}
          onChange={(e) => setSpacesEnabled(e.target.checked)}
        />
        Also create a Spaces bucket + scoped key for run artifacts
      </label>

      <label className="flex items-center gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={haControlPlane}
          onChange={(e) => setHaControlPlane(e.target.checked)}
        />
        Highly-available control plane (~$40/mo extra; can&apos;t be disabled
        later)
      </label>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className={labelClass}>Region</span>
          <SearchableSelect
            options={DO_REGIONS.map((r) => ({
              value: r,
              label: r,
              searchText: r,
            }))}
            value={region}
            onChange={(v) => setRegion(v ?? CLUSTER_DEPLOY_DEFAULTS.region)}
            placeholder="Region"
          />
        </div>
        <div>
          <span className={labelClass}>Node size</span>
          <SearchableSelect
            options={DO_NODE_SIZES.map((s) => ({
              value: s.slug,
              label: s.label,
              searchText: s.slug,
            }))}
            value={nodeSize}
            onChange={(v) => setNodeSize(v ?? CLUSTER_DEPLOY_DEFAULTS.nodeSize)}
            placeholder="Node size"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="deploy-min-nodes">
            Min nodes
          </label>
          <input
            id="deploy-min-nodes"
            type="number"
            min={1}
            max={100}
            value={minNodes}
            onChange={(e) => setMinNodes(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="deploy-max-nodes">
            Max nodes (autoscale)
          </label>
          <input
            id="deploy-max-nodes"
            type="number"
            min={1}
            max={100}
            value={maxNodes}
            onChange={(e) => setMaxNodes(Number(e.target.value))}
            className={inputClass}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-lg px-3 py-2 text-sm text-white/50 hover:text-white/80"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={start.isPending || !canSubmit}
          className="rounded-lg bg-sky-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {start.isPending ? "Validating…" : "Deploy cluster"}
        </button>
      </div>

      {start.error && (
        <p className="text-xs text-rose-300/90">{start.error.message}</p>
      )}
    </form>
  );
}

function DeployProgress({
  deployment,
  doToken,
}: {
  deployment: Deployment;
  doToken: string;
}) {
  const utils = api.useUtils();
  const cancel = api.clusterDeploy.cancel.useMutation({
    onSuccess: () => utils.clusterDeploy.status.invalidate(),
  });

  const currentIndex = CLUSTER_DEPLOY_STEPS.findIndex(
    (s) => s.status === deployment.status,
  );

  return (
    <div className="space-y-3" data-testid="cluster-deploy-progress">
      <ul className="space-y-1">
        {CLUSTER_DEPLOY_STEPS.map((step, i) => (
          <li
            key={step.status}
            className={`flex items-center gap-2 text-xs ${
              i < currentIndex
                ? "text-emerald-300/80"
                : i === currentIndex
                  ? "text-sky-300"
                  : "text-white/30"
            }`}
          >
            <span aria-hidden>
              {i < currentIndex ? "✓" : i === currentIndex ? "●" : "○"}
            </span>
            {step.label}
            {i === currentIndex && <Spinner />}
          </li>
        ))}
      </ul>

      {deployment.error && (
        <p className="text-xs text-amber-300/80">
          Retrying: {deployment.error}
        </p>
      )}

      <button
        type="button"
        onClick={() => cancel.mutate({ id: deployment.id, doToken })}
        disabled={cancel.isPending || !doToken}
        className="rounded-lg border border-rose-400/40 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-400/10 disabled:opacity-50"
      >
        {cancel.isPending
          ? "Cleaning up…"
          : "Cancel & delete created resources"}
      </button>
    </div>
  );
}

function DeploySuccess({ deployment }: { deployment: Deployment }) {
  const utils = api.useUtils();
  const { data: bundle } = api.clusterDeploy.adoptionBundle.useQuery();
  const dismiss = api.clusterDeploy.dismiss.useMutation({
    onSuccess: () => utils.clusterDeploy.status.invalidate(),
  });

  return (
    <div className="space-y-4" data-testid="cluster-deploy-success">
      <p className="text-xs text-emerald-300/90">
        Cluster <span className="font-mono">{deployment.clusterName}</span> is
        running ✓ Save its credentials below — they are shown only until you
        dismiss this.
      </p>

      {deployment.error && (
        <p className="text-xs text-amber-300/80">{deployment.error}</p>
      )}

      <KubeconfigOutput deployment={deployment} />

      {deployment.spacesEnabled && (
        <ArtifactStorageOutput deployment={deployment} />
      )}

      {bundle && (
        <div className="space-y-1">
          <p className="text-xs text-white/50">
            Manage this cluster with terraform later: download these into{" "}
            <span className="font-mono">deploy/terraform/digitalocean</span> and
            run <span className="font-mono">tofu init && tofu plan</span> to
            adopt the resources.
          </p>
          <div className="flex gap-2">
            <DownloadButton filename="imports.tf" content={bundle.importsTf} />
            <DownloadButton
              filename="terraform.tfvars"
              content={bundle.tfvars}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => dismiss.mutate({ id: deployment.id })}
        disabled={dismiss.isPending}
        className="rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/5 disabled:opacity-50"
      >
        Done — dismiss (forgets the kubeconfig and secret key)
      </button>
    </div>
  );
}

/** The generated ServiceAccount kubeconfig: copy, download, or save into the
 * user's Kubernetes settings — with a confirmation when a kubeconfig is
 * already configured there. */
function KubeconfigOutput({ deployment }: { deployment: Deployment }) {
  const utils = api.useUtils();
  const { data: kubeconfigStatus } = api.account.kubeconfigStatus.useQuery();
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = api.clusterDeploy.saveKubeconfig.useMutation({
    onSuccess: () => {
      setSaved(true);
      setConfirming(false);
      void utils.account.kubeconfigStatus.invalidate();
    },
  });

  if (!deployment.kubeconfig) return null;
  const kubeconfig = deployment.kubeconfig;

  return (
    <div className="space-y-2" data-testid="kubeconfig-output">
      <p className="text-xs text-white/50">
        Agent kubeconfig — save it to your settings so your agents run on this
        cluster, or take a copy elsewhere.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (saved) return;
            if (kubeconfigStatus?.configured && !confirming) {
              setConfirming(true);
              return;
            }
            save.mutate({ id: deployment.id });
          }}
          disabled={save.isPending || saved}
          className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-black hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saved ? "Saved ✓" : save.isPending ? "Saving…" : "Save to settings"}
        </button>
        <CopyButton value={kubeconfig} label="Copy kubeconfig" />
        <DownloadButton filename="kubeconfig.yaml" content={kubeconfig} />
      </div>

      {confirming && !saved && (
        <div
          className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3"
          data-testid="kubeconfig-overwrite-confirm"
        >
          <p className="text-xs text-amber-300/90">
            You already have a kubeconfig configured — saving will replace it
            and your agents will move to the new cluster.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => save.mutate({ id: deployment.id })}
              disabled={save.isPending}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
            >
              Replace existing
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-3 py-1.5 text-xs text-white/50 hover:text-white/80"
            >
              Keep existing
            </button>
          </div>
        </div>
      )}
      {save.error && (
        <p className="text-xs text-rose-300/90">{save.error.message}</p>
      )}
    </div>
  );
}

/** The bucket-scoped Spaces key: copy the individual values, download them as
 * a file, or insert them straight into a repo's run-artifact storage — with a
 * confirmation when that repo already has storage configured. */
function ArtifactStorageOutput({ deployment }: { deployment: Deployment }) {
  const [repoFullName, setRepoFullName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [insertedInto, setInsertedInto] = useState<string | null>(null);

  const { data: repos, isLoading: reposLoading } = api.repos.list.useQuery();
  // Admin-gated: errors for repos the user can't configure, which the insert
  // button surfaces as its disabled state + the error message below.
  const existing = api.webhooks.getCredentials.useQuery(
    { repoFullName: repoFullName! },
    { enabled: !!repoFullName, retry: false },
  );

  const insert = api.webhooks.setArtifacts.useMutation({
    onSuccess: () => {
      setInsertedInto(repoFullName);
      setConfirming(false);
    },
  });

  const credentialsFile = [
    "# Bandolier run-artifact storage (DigitalOcean Spaces)",
    `endpoint=${deployment.spacesEndpoint ?? ""}`,
    `region=${deployment.region}`,
    `bucket=${deployment.bucketName ?? ""}`,
    `access_key_id=${deployment.spacesAccessKeyId ?? ""}`,
    `secret_access_key=${deployment.spacesSecretAccessKey ?? ""}`,
    "",
  ].join("\n");

  const doInsert = () => {
    if (!repoFullName) return;
    insert.mutate({
      repoFullName,
      bucket: deployment.bucketName ?? "",
      region: deployment.region,
      endpoint: deployment.spacesEndpoint ?? "",
      accessKeyId: deployment.spacesAccessKeyId ?? "",
      secretAccessKey: deployment.spacesSecretAccessKey ?? "",
    });
  };

  const alreadyConfigured = existing.data?.artifacts.configured ?? false;

  return (
    <div className="space-y-2" data-testid="artifact-storage-output">
      <p className="text-xs text-white/50">
        Run-artifact storage — insert it into a repo&apos;s{" "}
        <em>Run artifact storage</em> settings, or take a copy. The secret key
        is shown only until you dismiss this.
      </p>
      <OutputRow label="Endpoint" value={deployment.spacesEndpoint} />
      <OutputRow label="Bucket" value={deployment.bucketName} />
      <OutputRow label="Access key" value={deployment.spacesAccessKeyId} />
      <OutputRow label="Secret key" value={deployment.spacesSecretAccessKey} />
      <div className="flex flex-wrap items-center gap-2">
        <DownloadButton
          filename="spaces-credentials.txt"
          content={credentialsFile}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <span className={labelClass}>Insert into a repo</span>
            <SearchableSelect
              options={(repos ?? []).map((r) => ({
                value: r.fullName,
                label: r.fullName,
                searchText: r.fullName.toLowerCase(),
              }))}
              value={repoFullName}
              onChange={(v) => {
                setRepoFullName(v);
                setConfirming(false);
              }}
              placeholder="Choose a repo…"
              loading={reposLoading}
              searchPlaceholder="Search repos…"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              if (alreadyConfigured && !confirming) {
                setConfirming(true);
                return;
              }
              doInsert();
            }}
            disabled={
              !repoFullName ||
              existing.isLoading ||
              !!existing.error ||
              insert.isPending ||
              insertedInto === repoFullName
            }
            className="shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-black hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {insertedInto === repoFullName
              ? "Inserted ✓"
              : insert.isPending
                ? "Inserting…"
                : "Insert"}
          </button>
        </div>

        {confirming && insertedInto !== repoFullName && (
          <div
            className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3"
            data-testid="artifacts-overwrite-confirm"
          >
            <p className="text-xs text-amber-300/90">
              <span className="font-mono">{repoFullName}</span> already has
              artifact storage configured
              {existing.data?.artifacts.configured
                ? ` (bucket ${existing.data.artifacts.bucket})`
                : ""}{" "}
              — inserting will replace it. Existing artifacts stay in the old
              bucket.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={doInsert}
                disabled={insert.isPending}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
              >
                Replace existing
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-white/50 hover:text-white/80"
              >
                Keep existing
              </button>
            </div>
          </div>
        )}

        {existing.error && (
          <p className="text-xs text-rose-300/90">
            Can&apos;t configure this repo: {existing.error.message}
          </p>
        )}
        {insert.error && (
          <p className="text-xs text-rose-300/90">{insert.error.message}</p>
        )}
      </div>
    </div>
  );
}

function DeployFailure({
  deployment,
  doToken,
}: {
  deployment: Deployment;
  doToken: string;
}) {
  const utils = api.useUtils();
  const invalidate = () => utils.clusterDeploy.status.invalidate();
  const cancel = api.clusterDeploy.cancel.useMutation({
    onSuccess: invalidate,
  });
  const dismiss = api.clusterDeploy.dismiss.useMutation({
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-2" data-testid="cluster-deploy-failure">
      <p className="text-xs text-rose-300/90">
        Deployment failed: {deployment.error ?? "unknown error"}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => cancel.mutate({ id: deployment.id, doToken })}
          disabled={cancel.isPending || !doToken}
          className="rounded-lg border border-rose-400/40 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-400/10 disabled:opacity-50"
        >
          {cancel.isPending ? "Cleaning up…" : "Delete created resources"}
        </button>
        <button
          type="button"
          onClick={() => dismiss.mutate({ id: deployment.id })}
          disabled={dismiss.isPending}
          className="rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/5 disabled:opacity-50"
        >
          Dismiss, keep resources
        </button>
      </div>
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      aria-label="working"
      className="inline-block h-3 w-3 animate-spin rounded-full border border-sky-300/60 border-t-transparent"
    />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/5"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function OutputRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-white/40">{label}</span>
      <span className="truncate font-mono text-white/80">{value}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 text-sky-300/80 hover:text-sky-300"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </div>
  );
}

function DownloadButton({
  filename,
  content,
}: {
  filename: string;
  content: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        const url = URL.createObjectURL(
          new Blob([content], { type: "text/plain" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/5"
    >
      ⬇ {filename}
    </button>
  );
}
