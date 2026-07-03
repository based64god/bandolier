provider "digitalocean" {
  # Falls back to the DIGITALOCEAN_TOKEN env var when unset.
  token = var.do_token != "" ? var.do_token : null

  # Needed to create the Spaces bucket (the bucket API is S3-compatible and
  # authenticates with Spaces keys, not the API token). Fall back to the
  # SPACES_ACCESS_KEY_ID / SPACES_SECRET_ACCESS_KEY env vars.
  spaces_access_id  = var.spaces_access_id != "" ? var.spaces_access_id : null
  spaces_secret_key = var.spaces_secret_key != "" ? var.spaces_secret_key : null
}

# The kubernetes/helm/kubectl providers talk to the DOKS cluster created in
# cluster.tf. DOKS kubeconfig tokens are short-lived; reading them off the
# cluster resource refreshes them on every plan/apply.

provider "kubernetes" {
  host                   = digitalocean_kubernetes_cluster.this.endpoint
  token                  = digitalocean_kubernetes_cluster.this.kube_config[0].token
  cluster_ca_certificate = base64decode(digitalocean_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes = {
    host                   = digitalocean_kubernetes_cluster.this.endpoint
    token                  = digitalocean_kubernetes_cluster.this.kube_config[0].token
    cluster_ca_certificate = base64decode(digitalocean_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
  }
}

provider "kubectl" {
  host                   = digitalocean_kubernetes_cluster.this.endpoint
  token                  = digitalocean_kubernetes_cluster.this.kube_config[0].token
  cluster_ca_certificate = base64decode(digitalocean_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
  load_config_file       = false
}
