# Installs the repo's Helm chart (deploy/helm/bandolier) onto the DOKS
# cluster, wired to the managed database and (when DNS is enabled) the
# ingress + Let's Encrypt issuer.

resource "random_password" "better_auth_secret" {
  length  = 48
  special = false
}

locals {
  bandolier_values = {
    replicaCount = var.app_replicas

    image = {
      tag = var.app_image_tag
    }

    config = {
      betterAuthUrl = local.app_url
      githubAppSlug = var.github_app_slug
    }

    ingress = {
      enabled     = local.dns_enabled
      className   = "nginx"
      annotations = local.dns_enabled ? { "cert-manager.io/cluster-issuer" = "letsencrypt" } : {}
      host        = local.dns_enabled ? local.hostname : "bandolier.example.com"
      tls = {
        enabled    = local.dns_enabled
        secretName = "bandolier-tls"
      }
    }

    postgres = {
      mode = var.managed_database ? "external" : "bundled"
    }

    secrets = {
      betterAuthSecret      = var.better_auth_secret != "" ? var.better_auth_secret : random_password.better_auth_secret.result
      githubClientId        = var.github_client_id
      githubClientSecret    = var.github_client_secret
      databaseUrl           = local.database_url
      githubWebhookSecret   = var.github_webhook_secret
      githubAppId           = var.github_app_id
      githubAppPrivateKey   = var.github_app_private_key
      githubAppClientId     = var.github_app_client_id
      githubAppClientSecret = var.github_app_client_secret
      appPassword           = var.app_password
    }
  }
}

resource "helm_release" "bandolier" {
  count = var.install_app ? 1 : 0

  name             = var.name
  chart            = "${path.module}/../../helm/bandolier"
  namespace        = var.app_namespace
  create_namespace = true
  # Covers the pre-install migration Job plus the app rollout.
  timeout = 600

  values = [yamlencode(local.bandolier_values)]

  depends_on = [
    digitalocean_database_firewall.postgres,
    kubectl_manifest.letsencrypt_issuer,
    digitalocean_record.app,
  ]

  lifecycle {
    precondition {
      condition     = var.github_client_id != "" && var.github_client_secret != ""
      error_message = "github_client_id and github_client_secret are required when install_app=true (create a GitHub OAuth app with callback URL <app url>/api/auth/callback/github)."
    }
  }
}
