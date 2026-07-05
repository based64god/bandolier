# DigitalOcean Managed PostgreSQL — the production-recommended database for the
# chart's postgres.mode=external. Placed on the cluster's VPC and firewalled so
# only pods on the DOKS cluster can reach it.

locals {
  managed_database = var.managed_database && !var.agent_only
}

resource "digitalocean_database_cluster" "postgres" {
  count = local.managed_database ? 1 : 0

  name                 = "${var.name}-postgres"
  engine               = "pg"
  version              = var.database_version
  size                 = var.database_size
  region               = var.region
  node_count           = var.database_node_count
  private_network_uuid = digitalocean_kubernetes_cluster.this.vpc_uuid
}

resource "digitalocean_database_db" "app" {
  count = local.managed_database ? 1 : 0

  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = "bandolier"
}

resource "digitalocean_database_user" "app" {
  count = local.managed_database ? 1 : 0

  cluster_id = digitalocean_database_cluster.postgres[0].id
  name       = "bandolier"
}

resource "digitalocean_database_firewall" "postgres" {
  count = local.managed_database ? 1 : 0

  cluster_id = digitalocean_database_cluster.postgres[0].id

  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.this.id
  }
}

locals {
  # Private-network URL; DO managed Postgres requires TLS, and the app's
  # postgres-js client honors sslmode=require. Empty when the chart bundles
  # its own Postgres instead.
  database_url = local.managed_database ? format(
    "postgresql://%s:%s@%s:%d/%s?sslmode=require",
    digitalocean_database_user.app[0].name,
    urlencode(digitalocean_database_user.app[0].password),
    digitalocean_database_cluster.postgres[0].private_host,
    digitalocean_database_cluster.postgres[0].port,
    digitalocean_database_db.app[0].name,
  ) : ""
}
