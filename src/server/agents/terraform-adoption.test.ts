import { describe, expect, it } from "vitest";

import { buildAdoptionBundle } from "~/server/agents/terraform-adoption";

const source = {
  clusterName: "bandolier-abc123",
  region: "nyc3",
  nodeSize: "s-4vcpu-8gb",
  minNodes: 1,
  maxNodes: 4,
  k8sVersion: "1.32.2-do.0",
  clusterId: "c-1111",
  spacesEnabled: true,
  bucketName: "bandolier-abc123-artifacts",
};

describe("buildAdoptionBundle", () => {
  it("emits import blocks for the cluster and bucket with real ids", () => {
    const { importsTf } = buildAdoptionBundle(source);
    expect(importsTf).toContain("to = digitalocean_kubernetes_cluster.this");
    expect(importsTf).toContain('id = "c-1111"');
    expect(importsTf).toContain("to = digitalocean_spaces_bucket.artifacts[0]");
    expect(importsTf).toContain('id = "nyc3,bandolier-abc123-artifacts"');
    // The scoped key has no importer; the bundle must say so.
    expect(importsTf).toMatch(/spaces_key has no\n# importer/);
  });

  it("emits tfvars that reproduce the deployed shape, agent-only, bucket pinned", () => {
    const { tfvars } = buildAdoptionBundle(source);
    expect(tfvars).toContain('name       = "bandolier-abc123"');
    expect(tfvars).toContain('region     = "nyc3"');
    expect(tfvars).toContain('node_size  = "s-4vcpu-8gb"');
    expect(tfvars).toContain("min_nodes  = 1");
    expect(tfvars).toContain("max_nodes  = 4");
    expect(tfvars).toContain("agent_only = true");
    expect(tfvars).toContain('kubernetes_version_prefix = "1.32."');
    expect(tfvars).toContain(
      'spaces_bucket_name = "bandolier-abc123-artifacts"',
    );
  });

  it("omits the bucket import and pins spaces off when spaces was disabled", () => {
    const { importsTf, tfvars } = buildAdoptionBundle({
      ...source,
      spacesEnabled: false,
      bucketName: null,
    });
    expect(importsTf).not.toContain("digitalocean_spaces_bucket");
    expect(tfvars).toContain("spaces_enabled = false");
    expect(tfvars).not.toContain("spaces_bucket_name");
  });

  it("drops the version pin when the deployed version is unknown", () => {
    const { tfvars } = buildAdoptionBundle({ ...source, k8sVersion: null });
    expect(tfvars).not.toContain("kubernetes_version_prefix");
  });
});
