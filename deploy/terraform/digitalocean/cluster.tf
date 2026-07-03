# DOKS cluster the web app (and, by default, the agent Jobs) run on.
#
# DOKS ships Cilium as the CNI, which enforces NetworkPolicy — so the chart's
# agent-pod isolation (config.agentNetworkPolicy=true) works out of the box.

data "digitalocean_kubernetes_versions" "this" {
  version_prefix = var.kubernetes_version_prefix != "" ? var.kubernetes_version_prefix : null
}

resource "digitalocean_kubernetes_cluster" "this" {
  name          = var.name
  region        = var.region
  version       = data.digitalocean_kubernetes_versions.this.latest_version
  auto_upgrade  = true
  surge_upgrade = true
  ha            = var.ha_control_plane

  node_pool {
    name       = "default"
    size       = var.node_size
    auto_scale = true
    min_nodes  = var.min_nodes
    max_nodes  = var.max_nodes
  }
}
