// Day-2 handoff for one-click deploys: generated import blocks + tfvars that
// let the user adopt the API-created resources into the repo's
// deploy/terraform/digitalocean configuration (`tofu init && tofu plan`
// materializes real state on their machine). Everything here is secret-free.

interface AdoptionSource {
  clusterName: string;
  region: string;
  nodeSize: string;
  minNodes: number;
  maxNodes: number;
  haControlPlane: boolean;
  k8sVersion: string | null;
  clusterId: string;
  spacesEnabled: boolean;
  bucketName: string | null;
}

export interface AdoptionBundle {
  /** Drop into deploy/terraform/digitalocean/imports.tf; delete after the
   * first successful apply. */
  importsTf: string;
  /** Drop into deploy/terraform/digitalocean/terraform.tfvars. */
  tfvars: string;
}

function hcl(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** "1.32.2-do.0" → "1.32." so the module's version data source tracks the
 * cluster's minor line instead of proposing an upgrade on the first plan
 * (auto_upgrade keeps the patch level moving on DO's side). */
function versionPrefix(slug: string | null): string | null {
  const match = /^(\d+\.\d+\.)/.exec(slug ?? "");
  return match ? match[1]! : null;
}

export function buildAdoptionBundle(source: AdoptionSource): AdoptionBundle {
  const imports: string[] = [
    `# Adopts the resources created by Bandolier's one-click deploy into the`,
    `# OpenTofu configuration under deploy/terraform/digitalocean. From that`,
    `# directory, with terraform.tfvars alongside and your credentials in the`,
    `# environment (DIGITALOCEAN_TOKEN, SPACES_ACCESS_KEY_ID/_SECRET_ACCESS_KEY):`,
    `#`,
    `#   tofu init && tofu plan`,
    `#`,
    `# then apply once the plan looks right, and delete this file.`,
    ``,
    `import {`,
    `  to = digitalocean_kubernetes_cluster.this`,
    `  id = ${hcl(source.clusterId)}`,
    `}`,
  ];
  if (source.spacesEnabled && source.bucketName) {
    imports.push(
      ``,
      `import {`,
      `  to = digitalocean_spaces_bucket.artifacts[0]`,
      `  id = ${hcl(`${source.region},${source.bucketName}`)}`,
      `}`,
      ``,
      `# Not imported: the bucket-scoped Spaces key (digitalocean_spaces_key has no`,
      `# importer, and its secret is only revealed at creation). The first apply`,
      `# mints a fresh scoped key; the one created at deploy time keeps working`,
      `# until you rotate your repos' artifact-storage settings and delete it.`,
    );
  }

  const prefix = versionPrefix(source.k8sVersion);
  const tfvars = [
    `# Matches the cluster deployed from the Bandolier UI (${source.clusterName}).`,
    `name       = ${hcl(source.clusterName)}`,
    `region     = ${hcl(source.region)}`,
    `node_size  = ${hcl(source.nodeSize)}`,
    `min_nodes  = ${source.minNodes}`,
    `max_nodes  = ${source.maxNodes}`,
    `agent_only = true`,
    // Always explicit: HA can't be disabled on an existing cluster, so a
    // tfvars that disagrees with reality would plan a change DO rejects.
    `ha_control_plane = ${source.haControlPlane}`,
    ...(prefix
      ? [
          ``,
          `# Track the deployed minor version instead of the newest available one.`,
          `kubernetes_version_prefix = ${hcl(prefix)}`,
        ]
      : []),
    ``,
    ...(source.spacesEnabled && source.bucketName
      ? [
          `# Pinned so the module adopts the existing bucket instead of generating`,
          `# a random-suffixed name.`,
          `spaces_enabled     = true`,
          `spaces_bucket_name = ${hcl(source.bucketName)}`,
        ]
      : [`spaces_enabled = false`]),
    ``,
  ];

  return { importsTf: imports.join("\n") + "\n", tfvars: tfvars.join("\n") };
}
