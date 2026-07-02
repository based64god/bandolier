# Self-hosting Bandolier on Kubernetes

This directory holds everything needed to run the **Bandolier web app** (the
Next.js + tRPC dashboard/server) on a Kubernetes cluster. It's the counterpart to
the agent-side images: the web app schedules agent **Jobs** onto whatever cluster
each user's kubeconfig points at, while this chart runs the web app itself.

- `helm/bandolier/` — a Helm chart deploying the app, its configuration, database
  migrations, and (optionally) a bundled Postgres.

> The web app is **cluster-agnostic** about where agents run: it talks to agent
> clusters only through user-supplied kubeconfig strings, never in-cluster
> credentials. So the app can live on the same cluster as its agents or a
> completely separate one — the only hard runtime dependency is a Postgres
> database.

## Images

The self-host workflow publishes two images from the repo-root `Dockerfile`:

| Image | Stage | Purpose |
| ----- | ----- | ------- |
| `ghcr.io/based64god/bandolier` | `runner` | The lean Next.js standalone server. This is the app. |
| `ghcr.io/based64god/bandolier-migrate` | `migrator` | `drizzle-kit` + the SQL under `drizzle/`. Runs schema migrations as a Helm hook. |

Both share a tag scheme, so pinning `image.tag` to a release (e.g. `v0.1.0`) pins
the migrator too (the chart defaults `migrations.image.tag` to `image.tag`).

These are **distinct** from the agent-side images
(`bandolier-agent-harness`, `bandolier-self-host`), which run *inside* agent Job
pods and are documented in the main [README](../README.md).

## Prerequisites

- A Kubernetes cluster (v1.24+) and `kubectl`/`helm` (v3.8+) pointed at it.
- A **PostgreSQL database**. Use a managed one in production (recommended), or
  let the chart deploy one (see [Database options](#database-options)).
- A **GitHub OAuth app** (client id + secret). Its callback URL must be
  `<your-public-url>/api/auth/callback/github`.
- An ingress controller and DNS if you want to expose the app at a hostname
  (otherwise use `kubectl port-forward`).

## Quick start (bundled Postgres, port-forward)

Fastest way to see it running — no external database, no ingress:

```bash
helm install bandolier deploy/helm/bandolier \
  --namespace bandolier --create-namespace \
  --set postgres.mode=bundled \
  --set config.betterAuthUrl=http://localhost:3000 \
  --set secrets.betterAuthSecret="$(openssl rand -base64 32)" \
  --set secrets.githubClientId=<oauth-client-id> \
  --set secrets.githubClientSecret=<oauth-client-secret>

kubectl -n bandolier port-forward svc/bandolier 3000:80
# open http://localhost:3000
```

For the OAuth callback to work, set your GitHub OAuth app's callback URL to
`http://localhost:3000/api/auth/callback/github` (and `config.betterAuthUrl` must
match the URL you actually reach the app on).

## Production (external Postgres + ingress + TLS)

Put your values in a file rather than on the command line so secrets don't land
in your shell history:

```yaml
# values.prod.yaml
image:
  tag: v0.1.0 # pin a release

config:
  betterAuthUrl: https://bandolier.example.com

ingress:
  enabled: true
  className: nginx
  host: bandolier.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    enabled: true
    secretName: bandolier-tls

secrets:
  betterAuthSecret: "<openssl rand -base64 32>"
  githubClientId: "<oauth-client-id>"
  githubClientSecret: "<oauth-client-secret>"
  databaseUrl: "postgresql://user:pass@your-db-host:5432/bandolier"
  # Optional GitHub App (bot comments + webhook delivery):
  # githubWebhookSecret: "..."
  # githubAppId: "..."
  # githubAppPrivateKey: |-
  #   -----BEGIN RSA PRIVATE KEY-----
  #   ...
  #   -----END RSA PRIVATE KEY-----
  # githubAppClientId: "..."
  # githubAppClientSecret: "..."
```

```bash
helm upgrade --install bandolier deploy/helm/bandolier \
  --namespace bandolier --create-namespace \
  -f values.prod.yaml
```

### Keeping real secrets out of Helm values

Committing secrets to a values file (even privately) leaves them in Helm's
release history. For production, manage the Secret out-of-band and point the
chart at it:

```bash
kubectl -n bandolier create secret generic bandolier-env \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_GITHUB_CLIENT_ID=... \
  --from-literal=BETTER_AUTH_GITHUB_CLIENT_SECRET=... \
  --from-literal=DATABASE_URL='postgresql://...'
  # add GITHUB_* / APP_PASSWORD keys as needed
```

```yaml
secrets:
  create: false
  existingSecret: bandolier-env
```

The Secret must provide the same keys the chart would (see
`helm/bandolier/templates/secret.yaml`). This also composes with
sealed-secrets / external-secrets operators.

## Database options

`postgres.mode` selects how the app gets its database:

| Mode | What it deploys | Use it for |
| ---- | --------------- | ---------- |
| `external` (default) | Nothing — you provide `secrets.databaseUrl`. | Production with a managed database. |
| `bundled` | A single-replica StatefulSet + PVC. | Evaluation / quick starts. |
| `cnpg` | A CloudNativePG `Cluster` (HA, failover, rolling upgrades, backups). | In-cluster production Postgres. |

For `bundled`/`cnpg`, the app's `DATABASE_URL` is **derived** from
`postgres.auth` (database/username/password) and the deployed service, so
`secrets.databaseUrl` is ignored. Tune each mode under `postgres.bundled.*` /
`postgres.cnpg.*` in [`values.yaml`](helm/bandolier/values.yaml).

### CloudNativePG (`postgres.mode=cnpg`)

Requires the **CloudNativePG operator** already installed in the cluster (the
chart only creates the `Cluster` CR, not the operator):

```bash
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml
```

Then:

```bash
helm upgrade --install bandolier deploy/helm/bandolier \
  --namespace bandolier --create-namespace \
  --set postgres.mode=cnpg \
  --set postgres.cnpg.instances=3 \
  --set config.betterAuthUrl=https://bandolier.example.com \
  --set secrets.betterAuthSecret="$(openssl rand -base64 32)" \
  --set secrets.githubClientId=<id> --set secrets.githubClientSecret=<secret>
```

The app connects to the primary via the operator's `<cluster>-rw` service.
Inspect the cluster with `kubectl get cluster bandolier-postgres`.

## Run artifacts (bundled MinIO)

Bandolier stores run transcripts in S3, configured **per repository** in the app
UI (Settings → a repo's *Run artifact storage*) — there is no server-wide bucket,
and the chart does **not** wire storage into the app automatically. Setting
`minio.enabled=true` is purely a convenience: it deploys an in-cluster,
S3-compatible MinIO and pre-creates a bucket, giving you an endpoint + credentials
to paste into a repo's settings.

```bash
helm upgrade --install bandolier deploy/helm/bandolier ... \
  --set minio.enabled=true \
  --set minio.auth.rootUser=<access-key> \
  --set minio.auth.rootPassword=<secret-key>
```

Then in a repo's *Run artifact storage* settings use:

- **Endpoint** — `http://bandolier-minio.<namespace>.svc:9000` (reachable only
  from agent pods **in this cluster**; enable `minio.ingress` for off-cluster
  access), or the ingress host if configured.
- **Bucket** — `minio.bucket` (default `bandolier-artifacts`).
- **Access / secret key** — `minio.auth.rootUser` / `minio.auth.rootPassword`.

## Database migrations

On every `helm install`/`upgrade`, a **hook Job** runs `drizzle-kit migrate`
(the migrator image) against `DATABASE_URL`, applying the SQL under `drizzle/`.
With an external database it's a **pre-install/pre-upgrade** hook (schema applied
before the new app pods roll out). When the chart deploys the database
(`bundled`/`cnpg`), the install-time migration runs **post-install** — the
database is created as a normal release resource that doesn't exist yet at
pre-install — and an init container waits for it to accept connections first;
upgrades still migrate pre-upgrade.

Disable it with `migrations.enabled=false` if you apply the schema yourself.
Inspect a run with:

```bash
kubectl -n bandolier logs job/bandolier-migrate
```

## Health & probes

The app exposes `GET /api/health`:

- **200** — process is up **and** Postgres is reachable (readiness).
- **503** — Postgres is unreachable; the pod is pulled from the Service.

The chart wires both the liveness and readiness probes here
(`probes.enabled=true`). The endpoint is exempt from the optional password gate.

## Configuration reference

The chart's values map onto the app's environment (validated in
[`src/env.js`](../src/env.js)); see the [main README's configuration
reference](../README.md#configuration-reference) for what each variable does.

| Value | Env var | Notes |
| ----- | ------- | ----- |
| `config.betterAuthUrl` | `BETTER_AUTH_URL` | Public URL; must match how you reach the app. |
| `config.k8sLabelSelector` | `K8S_LABEL_SELECTOR` | Selector for Bandolier-managed agent pods. |
| `config.agentNetworkPolicy` | `AGENT_NETWORK_POLICY` | Agent-pod isolation (needs a policy CNI). |
| `config.agentEgressBlockedCidrs` | `AGENT_EGRESS_BLOCKED_CIDRS` | CIDRs agents can't reach. |
| `config.githubAppSlug` | `NEXT_PUBLIC_GITHUB_APP_SLUG` | Links repo-config UI to the App. |
| `secrets.betterAuthSecret` | `BETTER_AUTH_SECRET` | **Required.** Session/token signing key. |
| `secrets.githubClientId` / `githubClientSecret` | `BETTER_AUTH_GITHUB_CLIENT_ID` / `_SECRET` | **Required.** OAuth app. |
| `secrets.databaseUrl` | `DATABASE_URL` | **Required** when `postgres.mode=external`; ignored for `bundled`/`cnpg`. |
| `secrets.githubWebhookSecret` | `GITHUB_WEBHOOK_SECRET` | Optional. Webhook signature verification. |
| `secrets.githubAppId` / `githubAppPrivateKey` / `githubAppClientId` / `githubAppClientSecret` | `GITHUB_APP_*` | Optional. Bot identity. |
| `secrets.appPassword` | `APP_PASSWORD` | Optional. Shared password gate. |

See [`helm/bandolier/values.yaml`](helm/bandolier/values.yaml) for the full,
commented list (replicas, resources, probes, ingress, and `postgres.*` /
`minio.*` tuning).

## Notes & caveats

- **`postgres.mode=bundled` is for evaluation.** It's a single-replica
  StatefulSet with no backups or HA. Use managed Postgres (`external`) or
  `cnpg` in production. If you do bundle it, keep
  `postgres.bundled.persistence.enabled=true` (the default) — an `emptyDir`
  loses all data when the pod reschedules.
- **`postgres.mode=cnpg` needs the CloudNativePG operator installed** in the
  cluster first; the chart only creates the `Cluster` custom resource.
- **Bundled MinIO is for evaluation too.** Single-replica, no HA; keep
  `minio.persistence.enabled=true`. It isn't wired into the app — a repo admin
  still points each repo at it in the UI.
- **Secrets are stored in the DB in plaintext.** As the main README notes, user
  AWS/Anthropic keys and kubeconfigs live unencrypted in Postgres. Protect the
  database and always serve the app over HTTPS.
- **The app pod runs read-only-rootfs and non-root** by default; it only needs
  writable `/tmp` and a Next cache dir, both mounted as `emptyDir`.
