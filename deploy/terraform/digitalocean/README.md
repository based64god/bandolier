# Bandolier on DigitalOcean with OpenTofu

One `tofu apply` that stands up everything Bandolier needs on
DigitalOcean and installs the [Helm chart](../../helm/bandolier):

| Component                             | Resource                                                      | Toggle                                  |
| ------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| Kubernetes cluster (app + agent Jobs) | DOKS, autoscaling node pool                                   | always                                  |
| PostgreSQL                            | Managed Database (private-network, firewalled to the cluster) | `managed_database` (default on)         |
| Run-artifact storage                  | Spaces bucket + bucket-scoped access key                      | `spaces_enabled` (default on)           |
| Public HTTPS entrypoint               | ingress-nginx + cert-manager (Let's Encrypt) + DO DNS record  | `dns_zone` (default off → port-forward) |
| The app                               | `helm_release` of `deploy/helm/bandolier`                     | `install_app` (default on)              |

DOKS ships Cilium, which enforces NetworkPolicy — so the chart's agent-pod
isolation (`config.agentNetworkPolicy=true`, the default) works without extra
setup.

**Rough monthly cost with defaults** (nyc3, 2026 pricing): one `s-4vcpu-8gb`
node ~$48 (autoscales 1–4), `db-s-1vcpu-1gb` Postgres ~$15, Spaces ~$5. Adding
`dns_zone` provisions a load balancer (~$12). Scale `node_size`/`min_nodes` to
your expected agent concurrency — each agent run is a Job on this cluster.

## Prerequisites

- [OpenTofu](https://opentofu.org) ≥ 1.6 (and `doctl` + `kubectl` for day-2
  access, optional). Terraform also works — the configuration uses no
  OpenTofu-only features — but CI validates with OpenTofu.
- A DigitalOcean **API token** (control panel → API → Tokens) with write scope.
- A **Spaces admin key pair** (API → Spaces Keys) — OpenTofu needs it to
  create the bucket, because the bucket API authenticates with Spaces keys
  rather than the API token. The module then mints a separate key **scoped to
  the one bucket** for the app to use.
- A **GitHub OAuth app** (Settings → Developer settings → OAuth Apps). You can
  create it after the first apply once you know the URL; the callback must be
  `<app url>/api/auth/callback/github`.

```bash
export DIGITALOCEAN_TOKEN=dop_v1_...
export SPACES_ACCESS_KEY_ID=DO...
export SPACES_SECRET_ACCESS_KEY=...
```

## Quick start (private, port-forward)

No domain needed; the app is reached through a tunnel:

```bash
cd deploy/terraform/digitalocean
cp terraform.tfvars.example terraform.tfvars   # fill in github_client_id/secret
tofu init
tofu apply                                      # ~10 minutes

doctl kubernetes cluster kubeconfig save bandolier
kubectl -n bandolier port-forward svc/bandolier 3000:80
# open http://localhost:3000
```

Set the GitHub OAuth app's callback URL to
`http://localhost:3000/api/auth/callback/github` for this mode.

## Public HTTPS

Requires a domain whose nameservers point at DigitalOcean DNS
(`ns1–3.digitalocean.com`):

```hcl
dns_zone          = "example.com"
create_dns_zone   = true            # false if the zone already exists in DO DNS
dns_record        = "bandolier"     # app at https://bandolier.example.com
letsencrypt_email = "you@example.com"
```

Apply, then update the OAuth callback to
`https://bandolier.example.com/api/auth/callback/github`. The certificate is
issued via HTTP-01 right after the A record propagates — allow a few minutes on
first apply; cert-manager retries automatically.

## After the apply

1. **Sign in** with GitHub at the `app_url` output.
2. **Paste a kubeconfig** in the app's settings so it can schedule agent Jobs —
   see [Agent-cluster kubeconfig](#agent-cluster-kubeconfig) below (don't paste
   the `kubeconfig` output; its token expires weekly).
3. **Wire artifact storage per repo** (Settings → repo → _Run artifact
   storage_) with the Spaces outputs:

   ```bash
   tofu output spaces_endpoint            # e.g. https://nyc3.digitaloceanspaces.com
   tofu output spaces_bucket
   tofu output spaces_access_key_id
   tofu output -raw spaces_secret_access_key
   ```

### Agent-cluster kubeconfig

Bandolier stores the kubeconfig and uses it long-term, but DOKS-issued user
tokens expire after about a week. Create a ServiceAccount with a long-lived
token and paste a kubeconfig built on that instead (the app creates
namespaces, Jobs, Secrets, and NetworkPolicies, so it needs broad rights):

```bash
doctl kubernetes cluster kubeconfig save bandolier
kubectl create serviceaccount bandolier-deployer -n kube-system
kubectl create clusterrolebinding bandolier-deployer \
  --clusterrole=cluster-admin --serviceaccount=kube-system:bandolier-deployer
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: bandolier-deployer-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: bandolier-deployer
type: kubernetes.io/service-account-token
EOF

SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl -n kube-system get secret bandolier-deployer-token -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl -n kube-system get secret bandolier-deployer-token -o jsonpath='{.data.token}' | base64 -d)

cat <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: bandolier
    cluster: { server: $SERVER, certificate-authority-data: $CA }
users:
  - name: bandolier-deployer
    user: { token: $TOKEN }
contexts:
  - name: bandolier
    context: { cluster: bandolier, user: bandolier-deployer }
current-context: bandolier
EOF
```

Paste that output into _Settings → Kubernetes_ (per user) or a repo's shared
kubeconfig.

## Day-2

- **Upgrade the app** — bump `app_image_tag` and `tofu apply`; the chart's
  pre-upgrade hook runs database migrations before the rollout.
- **Kubernetes upgrades** — `auto_upgrade` is on; DOKS applies patch upgrades
  in its maintenance window.
- **State contains secrets** (database password, generated
  `BETTER_AUTH_SECRET`, Spaces keys) — use an encrypted remote backend or
  OpenTofu's built-in [state encryption](https://opentofu.org/docs/language/state/encryption/),
  and guard access either way.

## Notes & caveats

- **Region** must offer both DOKS and Spaces (`nyc3`, `sfo3`, `ams3`, `fra1`,
  `sgp1`, `blr1`, `syd1` do).
- **`managed_database=false`** switches the chart to its bundled single-replica
  Postgres — evaluation only, and `tofu destroy` deletes its volume and
  data with the cluster.
- **Let's Encrypt production rate limits** apply (5 duplicate certs/week).
  Repeated create/destroy cycles of the same hostname can hit them.
- **Destroy order**: `tofu destroy` removes the Helm releases first, which
  deletes the ingress load balancer; if a destroy is interrupted, check the DO
  control panel for an orphaned load balancer or volumes from PVCs.
- The GitHub App (webhook-triggered runs) is configured with the
  `github_app_*` variables; see the [main README](../../../README.md#github-app-optional)
  for creating one.
