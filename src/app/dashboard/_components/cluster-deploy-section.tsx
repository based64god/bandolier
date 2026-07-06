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

  const tick = api.clusterDeploy.tick.useMutation({
    onSuccess: (d) => {
      utils.clusterDeploy.status.setData(undefined, d);
      if (d.status === "done") {
        void utils.account.kubeconfigStatus.invalidate();
        void utils.clusterDeploy.adoptionBundle.invalidate();
      }
    },
  });
  const { mutate: tickMutate } = tick;

  const activeId =
    deployment && !isTerminalStatus(deployment.status) ? deployment.id : null;
  useEffect(() => {
    if (!activeId) return;
    // Ticks are idempotent server-side, so an overlap with a slow step is
    // harmless — no in-flight guard needed.
    const interval = setInterval(
      () => tickMutate({ id: activeId }),
      POLL_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [activeId, tickMutate]);

  // Presented like the GitHub App install card in repo config: a boxed
  // callout with a prominent CTA, sitting at the top of the settings modal.
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-xs font-semibold tracking-wider text-white/50 uppercase">
        Deploy an agent cluster
      </h3>

      {!deployment && <DeployForm />}
      {deployment && !isTerminalStatus(deployment.status) && (
        <DeployProgress deployment={deployment} />
      )}
      {deployment?.status === "done" && (
        <DeploySuccess deployment={deployment} />
      )}
      {deployment?.status === "failed" && (
        <DeployFailure deployment={deployment} />
      )}
    </div>
  );
}

function DeployForm() {
  const utils = api.useUtils();
  const { data: kubeconfigStatus } = api.account.kubeconfigStatus.useQuery();
  const [expanded, setExpanded] = useState(false);

  const [doToken, setDoToken] = useState("");
  const [spacesEnabled, setSpacesEnabled] = useState(true);
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
          DigitalOcean API token. Its kubeconfig is wired into your settings
          automatically, and the resources match the repo&apos;s terraform
          setup, so you can adopt them with terraform later.
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
      {kubeconfigStatus?.configured && (
        <p className="text-xs text-amber-300/80">
          You already have a kubeconfig configured — it will be replaced when
          the deployment completes.
        </p>
      )}

      <div>
        <label className={labelClass} htmlFor="do-token">
          DigitalOcean API token (write scope)
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

function DeployProgress({ deployment }: { deployment: Deployment }) {
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
        onClick={() => cancel.mutate({ id: deployment.id })}
        disabled={cancel.isPending}
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
    <div className="space-y-3" data-testid="cluster-deploy-success">
      <p className="text-xs text-emerald-300/90">
        Cluster <span className="font-mono">{deployment.clusterName}</span> is
        running and its kubeconfig has been saved to your settings ✓
      </p>

      {deployment.spacesEnabled && (
        <div className="space-y-1">
          <p className="text-xs text-white/50">
            Run-artifact storage — paste into a repo&apos;s{" "}
            <em>Run artifact storage</em> settings. The secret key is shown only
            until you dismiss this.
          </p>
          <OutputRow label="Endpoint" value={deployment.spacesEndpoint} />
          <OutputRow label="Bucket" value={deployment.bucketName} />
          <OutputRow label="Access key" value={deployment.spacesAccessKeyId} />
          <OutputRow
            label="Secret key"
            value={deployment.spacesSecretAccessKey}
          />
        </div>
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
        Done — dismiss (forgets the secret key)
      </button>
    </div>
  );
}

function DeployFailure({ deployment }: { deployment: Deployment }) {
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
          onClick={() => cancel.mutate({ id: deployment.id })}
          disabled={cancel.isPending}
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
