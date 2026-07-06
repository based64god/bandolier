// Client-safe constants for one-click DigitalOcean cluster deploys, shared by
// the server state machine, the tRPC router, and the settings-modal wizard.
// Values mirror deploy/terraform/digitalocean/variables.tf so a UI deploy and
// a terraform deploy produce the same shape.

/** Regions offering both DOKS and Spaces (see the terraform README). */
export const DO_REGIONS = [
  "nyc3",
  "sfo3",
  "ams3",
  "fra1",
  "sgp1",
  "blr1",
  "syd1",
] as const;
export type DoRegion = (typeof DO_REGIONS)[number];

export const CLUSTER_DEPLOY_DEFAULTS = {
  region: "nyc3",
  nodeSize: "s-4vcpu-8gb",
  minNodes: 1,
  // The terraform default is 4, but fresh DO accounts ship with a droplet
  // limit of 3 — a default the account can actually satisfy beats parity.
  maxNodes: 3,
} as const;

/** Droplet sizes offered in the wizard (agent runs are Jobs on these nodes —
 * sized for expected concurrency). Any valid slug is accepted server-side. */
export const DO_NODE_SIZES = [
  { slug: "s-2vcpu-4gb", label: "s-2vcpu-4gb — 2 vCPU / 4 GB (~$24/mo)" },
  { slug: "s-4vcpu-8gb", label: "s-4vcpu-8gb — 4 vCPU / 8 GB (~$48/mo)" },
  { slug: "s-8vcpu-16gb", label: "s-8vcpu-16gb — 8 vCPU / 16 GB (~$96/mo)" },
] as const;

export const CLUSTER_DEPLOY_STATUSES = [
  "pending",
  "waiting-cluster",
  "creating-bucket",
  "creating-key",
  "bootstrapping-kubeconfig",
  "done",
  "failed",
  "dismissed",
] as const;
export type ClusterDeployStatus = (typeof CLUSTER_DEPLOY_STATUSES)[number];

export function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "dismissed";
}

/** Progress display: the in-flight statuses in order, with user-facing labels. */
export const CLUSTER_DEPLOY_STEPS: {
  status: ClusterDeployStatus;
  label: string;
}[] = [
  { status: "pending", label: "Creating Kubernetes cluster" },
  { status: "waiting-cluster", label: "Waiting for the cluster (~5–10 min)" },
  { status: "creating-bucket", label: "Creating artifacts bucket" },
  { status: "creating-key", label: "Minting bucket-scoped access key" },
  {
    status: "bootstrapping-kubeconfig",
    label: "Bootstrapping agent kubeconfig",
  },
];
