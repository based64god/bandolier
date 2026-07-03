# Optional public entrypoint, active when dns_zone is set:
# ingress-nginx (behind a DO load balancer) + cert-manager (Let's Encrypt
# HTTP-01) + a DNS A record for the app's hostname.

locals {
  dns_enabled = var.dns_zone != ""
  hostname    = local.dns_enabled ? (var.dns_record == "@" ? var.dns_zone : "${var.dns_record}.${var.dns_zone}") : ""
  app_url     = local.dns_enabled ? "https://${local.hostname}" : "http://localhost:3000"
}

resource "digitalocean_domain" "zone" {
  count = local.dns_enabled && var.create_dns_zone ? 1 : 0
  name  = var.dns_zone
}

resource "helm_release" "ingress_nginx" {
  count = local.dns_enabled ? 1 : 0

  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = var.ingress_nginx_chart_version
  namespace        = "ingress-nginx"
  create_namespace = true
  # wait=true (default) blocks until the DO load balancer is provisioned, so
  # the service data source below sees its IP.
  timeout = 600

  depends_on = [digitalocean_kubernetes_cluster.this]
}

data "kubernetes_service" "ingress_nginx" {
  count = local.dns_enabled ? 1 : 0

  metadata {
    name      = "ingress-nginx-controller"
    namespace = "ingress-nginx"
  }

  depends_on = [helm_release.ingress_nginx]
}

resource "digitalocean_record" "app" {
  count = local.dns_enabled ? 1 : 0

  domain = var.create_dns_zone ? digitalocean_domain.zone[0].id : var.dns_zone
  type   = "A"
  name   = var.dns_record
  value  = data.kubernetes_service.ingress_nginx[0].status[0].load_balancer[0].ingress[0].ip
  ttl    = 300
}

resource "helm_release" "cert_manager" {
  count = local.dns_enabled ? 1 : 0

  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = var.cert_manager_chart_version
  namespace        = "cert-manager"
  create_namespace = true
  # wait=true so the webhook is ready before the ClusterIssuer is applied.
  timeout = 600

  values = [yamlencode({
    crds = { enabled = true }
  })]

  depends_on = [digitalocean_kubernetes_cluster.this]
}

resource "kubectl_manifest" "letsencrypt_issuer" {
  count = local.dns_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata   = { name = "letsencrypt" }
    spec = {
      acme = {
        server              = "https://acme-v02.api.letsencrypt.org/directory"
        email               = var.letsencrypt_email
        privateKeySecretRef = { name = "letsencrypt-account-key" }
        solvers = [{
          http01 = { ingress = { ingressClassName = "nginx" } }
        }]
      }
    }
  })

  depends_on = [helm_release.cert_manager]

  lifecycle {
    precondition {
      condition     = var.letsencrypt_email != ""
      error_message = "letsencrypt_email is required when dns_zone is set (Let's Encrypt account contact)."
    }
  }
}
