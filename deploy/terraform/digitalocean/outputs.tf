# ── Cluster ───────────────────────────────────────────────────────────────────

output "cluster_id" {
  description = "DOKS cluster id."
  value       = digitalocean_kubernetes_cluster.this.id
}

output "kubeconfig_command" {
  description = "Fetch a kubeconfig for kubectl/helm access to the cluster."
  value       = "doctl kubernetes cluster kubeconfig save ${digitalocean_kubernetes_cluster.this.name}"
}

output "kubeconfig" {
  description = "Raw kubeconfig for the cluster. NOTE: the embedded token expires after ~7 days — for the kubeconfig you paste into Bandolier (which it keeps to schedule agent Jobs), create a long-lived ServiceAccount kubeconfig instead (see the README)."
  value       = digitalocean_kubernetes_cluster.this.kube_config[0].raw_config
  sensitive   = true
}

# ── App ───────────────────────────────────────────────────────────────────────

output "app_url" {
  description = "Where the app is served. Without DNS this is the port-forward address — run: kubectl -n <namespace> port-forward svc/<name> 3000:80"
  value       = local.app_url
}

output "ingress_load_balancer_ip" {
  description = "Public IP of the ingress load balancer (empty when DNS is disabled)."
  value       = local.dns_enabled ? data.kubernetes_service.ingress_nginx[0].status[0].load_balancer[0].ingress[0].ip : ""
}

# ── Database ──────────────────────────────────────────────────────────────────

output "database_url" {
  description = "The app's DATABASE_URL (private-network host; only reachable from the cluster). Empty when managed_database=false."
  value       = local.database_url
  sensitive   = true
}

# ── Spaces (run artifacts) ────────────────────────────────────────────────────
# Paste these into a repo's "Run artifact storage" settings in the Bandolier UI.

output "spaces_endpoint" {
  description = "S3-compatible endpoint for the artifacts bucket."
  value       = var.spaces_enabled ? "https://${var.region}.digitaloceanspaces.com" : ""
}

output "spaces_bucket" {
  description = "Run-artifacts bucket name."
  value       = local.spaces_bucket_name
}

output "spaces_access_key_id" {
  description = "Bucket-scoped access key id for the app."
  value       = var.spaces_enabled ? digitalocean_spaces_key.artifacts[0].access_key : ""
}

output "spaces_secret_access_key" {
  description = "Bucket-scoped secret key for the app."
  value       = var.spaces_enabled ? digitalocean_spaces_key.artifacts[0].secret_key : ""
  sensitive   = true
}
