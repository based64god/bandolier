# ── Credentials ───────────────────────────────────────────────────────────────

variable "do_token" {
  description = "DigitalOcean API token. Leave empty to use the DIGITALOCEAN_TOKEN env var."
  type        = string
  default     = ""
  sensitive   = true
}

variable "spaces_access_id" {
  description = "Spaces access key id used by Terraform itself to create the bucket (admin key from the DO control panel → API → Spaces Keys). Leave empty to use the SPACES_ACCESS_KEY_ID env var. Distinct from the scoped key this module creates for the app."
  type        = string
  default     = ""
  sensitive   = true
}

variable "spaces_secret_key" {
  description = "Spaces secret key paired with spaces_access_id. Leave empty to use the SPACES_SECRET_ACCESS_KEY env var."
  type        = string
  default     = ""
  sensitive   = true
}

# ── Naming & placement ────────────────────────────────────────────────────────

variable "name" {
  description = "Base name for every resource (cluster, database, bucket prefix, Helm release)."
  type        = string
  default     = "bandolier"
}

variable "region" {
  description = "DigitalOcean region slug. Must support both DOKS and Spaces (e.g. nyc3, sfo3, ams3, fra1, sgp1, blr1, syd1)."
  type        = string
  default     = "nyc3"
}

# ── Kubernetes cluster ────────────────────────────────────────────────────────

variable "kubernetes_version_prefix" {
  description = "DOKS version prefix to track (e.g. \"1.33.\"). Empty tracks the latest available version."
  type        = string
  default     = ""
}

variable "node_size" {
  description = "Droplet size for worker nodes. Agent runs are Jobs on this cluster, so size for your expected concurrency."
  type        = string
  default     = "s-4vcpu-8gb"
}

variable "min_nodes" {
  description = "Autoscaler lower bound for the default node pool."
  type        = number
  default     = 1
}

variable "max_nodes" {
  description = "Autoscaler upper bound for the default node pool. The default fits a fresh DigitalOcean account's droplet limit of 3; raise it together with your account limit."
  type        = number
  default     = 3
}

variable "ha_control_plane" {
  description = "Enable the highly-available DOKS control plane (extra monthly cost)."
  type        = bool
  default     = false
}

variable "agent_only" {
  description = "Provision an agent-only cluster: DOKS (plus Spaces, when enabled) with no database and no Bandolier Helm release. Use when this cluster only runs agent Jobs for a Bandolier app hosted elsewhere — paste this cluster's kubeconfig into that app. Overrides managed_database and install_app; incompatible with dns_zone."
  type        = bool
  default     = false
}

# ── Database ──────────────────────────────────────────────────────────────────

variable "managed_database" {
  description = "Provision a DigitalOcean Managed PostgreSQL cluster (recommended). When false, the Helm chart falls back to its bundled single-replica Postgres (evaluation only)."
  type        = bool
  default     = true
}

variable "database_size" {
  description = "Managed database node size slug."
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "database_node_count" {
  description = "Managed database node count (>1 adds standby nodes for failover)."
  type        = number
  default     = 1
}

variable "database_version" {
  description = "PostgreSQL major version for the managed database."
  type        = string
  default     = "17"
}

# ── Spaces (run artifacts) ────────────────────────────────────────────────────

variable "spaces_enabled" {
  description = "Create a Spaces bucket + scoped access key for run-artifact storage. Bandolier configures artifact storage per repository in the UI; the outputs give you the values to paste there."
  type        = bool
  default     = true
}

variable "spaces_bucket_name" {
  description = "Spaces bucket name. Bucket names are globally unique per region; empty generates \"<name>-artifacts-<random>\"."
  type        = string
  default     = ""
}

# ── DNS & TLS (optional) ──────────────────────────────────────────────────────
# When dns_zone is set, the module installs ingress-nginx + cert-manager,
# creates an A record for the app, and serves it over HTTPS with a Let's
# Encrypt certificate. When empty, the app stays on a ClusterIP service and is
# reached with `kubectl port-forward` (see outputs).

variable "dns_zone" {
  description = "A domain managed (or to be managed) in DigitalOcean DNS, e.g. \"example.com\". Empty disables ingress, DNS, and TLS."
  type        = string
  default     = ""
}

variable "create_dns_zone" {
  description = "Create dns_zone in DigitalOcean DNS. Leave false if the domain already exists in your DO account; you must point the domain's NS records at DigitalOcean either way."
  type        = bool
  default     = false
}

variable "dns_record" {
  description = "Record for the app inside dns_zone (\"bandolier\" → bandolier.example.com, \"@\" → the apex)."
  type        = string
  default     = "bandolier"
}

variable "letsencrypt_email" {
  description = "Email for the Let's Encrypt account (expiry notices). Required when dns_zone is set."
  type        = string
  default     = ""
}

variable "ingress_nginx_chart_version" {
  description = "ingress-nginx Helm chart version."
  type        = string
  default     = "4.12.1"
}

variable "cert_manager_chart_version" {
  description = "cert-manager Helm chart version."
  type        = string
  default     = "v1.17.2"
}

# ── Bandolier app ─────────────────────────────────────────────────────────────

variable "install_app" {
  description = "Install the Bandolier Helm chart onto the cluster. Disable for an infrastructure-only apply."
  type        = bool
  default     = true
}

variable "app_namespace" {
  description = "Kubernetes namespace for the app."
  type        = string
  default     = "bandolier"
}

variable "app_image_tag" {
  description = "Bandolier image tag (also used for the migrator). Pin a release in production; \"latest\" tracks main."
  type        = string
  default     = "latest"
}

variable "app_replicas" {
  description = "Web-app replica count."
  type        = number
  default     = 1
}

variable "github_client_id" {
  description = "GitHub OAuth app client id. Required when install_app=true. The OAuth app's callback URL must be <app url>/api/auth/callback/github."
  type        = string
  default     = ""
}

variable "github_client_secret" {
  description = "GitHub OAuth app client secret. Required when install_app=true."
  type        = string
  default     = ""
  sensitive   = true
}

variable "better_auth_secret" {
  description = "Session/token signing secret. Empty generates one and keeps it in Terraform state."
  type        = string
  default     = ""
  sensitive   = true
}

variable "app_password" {
  description = "Optional shared password gate in front of the whole app (APP_PASSWORD)."
  type        = string
  default     = ""
  sensitive   = true
}

# Optional GitHub App (bot comments + webhook-triggered runs).
variable "github_app_id" {
  description = "GitHub App id (optional)."
  type        = string
  default     = ""
}

variable "github_app_private_key" {
  description = "GitHub App private key PEM (optional)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_app_client_id" {
  description = "GitHub App OAuth client id (optional)."
  type        = string
  default     = ""
}

variable "github_app_client_secret" {
  description = "GitHub App OAuth client secret (optional)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_webhook_secret" {
  description = "GitHub App webhook secret (optional)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_app_slug" {
  description = "Public slug of the GitHub App, links the repo-config UI to its install page (optional)."
  type        = string
  default     = ""
}
