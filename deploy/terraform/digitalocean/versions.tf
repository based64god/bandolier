# Provider requirements for the DigitalOcean self-hosting stack. Written for
# OpenTofu (>= 1.6, its first release), but uses no OpenTofu-only features, so
# Terraform >= 1.6 works too.
#
# helm is pinned to 3.x, which uses the `kubernetes = { ... }` attribute syntax
# (not the 2.x `kubernetes { ... }` block). kubectl (alekc fork, maintained) is
# used only to apply the cert-manager ClusterIssuer, because kubernetes_manifest
# cannot plan CRs whose CRDs don't exist yet.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.50"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.32"
    }
    kubectl = {
      source  = "alekc/kubectl"
      version = "~> 2.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
