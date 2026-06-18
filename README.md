# Bandolier

Bandolier is a web app for running [Claude Code](https://www.anthropic.com/claude-code) agents as Kubernetes Jobs. You sign in with GitHub, point an agent at a repository or an issue, and Bandolier spins up an isolated pod that clones the repo, runs Claude Code non-interactively, and opens a pull request with the result. You watch progress live from a dashboard.

Agents can be launched two ways:

- **From the dashboard** — pick a repo, write a task (or select an open issue), choose a model, and deploy.
- **From a GitHub webhook** — when an issue is opened in a configured repo, Bandolier automatically launches an agent to work on it and open a PR.

Every agent runs with the **deploying user's own credentials** — their GitHub OAuth token, their AWS Bedrock or Anthropic API key, and the cluster from their kubeconfig. There are no shared, server-side provider credentials; the available models are queried live from each user's provider.

---

## How it works

Bandolier has two deployable pieces:

1. **The web app** (this repo, `src/`) — a Next.js + tRPC application. It handles auth, stores per-user credentials, talks to the Kubernetes API, and serves the dashboard.
2. **The agent harness** (`agent-harness/`) — a small Go binary baked into a container image alongside the Claude Code CLI, `git`, and `gh`. This is what actually runs inside each agent pod.

When you deploy an agent, the web app:

1. Resolves your credentials (GitHub token, model provider, kubeconfig) from the database.
2. Creates a namespace, a `bandolier-agent` ServiceAccount, and (optionally) a `NetworkPolicy` that isolates agent pods.
3. Writes a short-lived **per-job Secret** holding only that run's credentials, owned by the Job so Kubernetes garbage-collects it when the Job is deleted.
4. Creates a Kubernetes **Job** running the harness image, with the task wired in via environment variables.

The harness then clones the repo, runs `claude --print`, commits the work, pushes a branch, and opens a PR. The PR title and description are written out-of-band by the latest Sonnet model, regardless of which model performed the task. Logs stream back to the dashboard; if artifact storage is configured, the full transcript is uploaded to S3 so it outlives the Job's TTL.

```
Browser ──▶ Next.js app ──▶ Kubernetes API ──▶ Job (harness pod)
                │                                   │
                ├─ Postgres (users, creds, runs)    ├─ git clone
                └─ S3 (transcripts, optional)       ├─ claude --print
                                                    └─ gh pr create
```

---

## Prerequisites

- **Node.js 20+** and **pnpm 10** (`corepack enable` will pick up the pinned version).
- **Docker** or **Podman** — for the local Postgres database (and for building the harness image).
- **A PostgreSQL database** — the included script starts one in a container.
- **A Kubernetes cluster** the web app can reach and create Jobs in. For local development, [kind](https://kind.sigs.k8s.io/), [k3d](https://k3d.io/), or minikube all work. The cluster must be able to pull the harness image (see [The agent harness image](#the-agent-harness-image)).
- **A GitHub OAuth app** — for sign-in and repo access.
- **A model provider** — each user supplies their own AWS Bedrock credentials or Anthropic API key in the app; nothing provider-related is needed in server config.

---

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create a GitHub OAuth app

In GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- **Homepage URL**: `http://localhost:3000`
- **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`

Copy the **Client ID** and generate a **Client Secret**. The app requests the `repo` and `workflow` scopes so agents can clone private repos and open PRs (including ones that touch `.github/workflows/`).

### 3. Configure environment

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Minimum required for local development:

```bash
# A random secret — generate one with: openssl rand -base64 32
BETTER_AUTH_SECRET="…"

# From the GitHub OAuth app you just created
BETTER_AUTH_GITHUB_CLIENT_ID="…"
BETTER_AUTH_GITHUB_CLIENT_SECRET="…"

# Local Postgres (matches start-database.sh below)
DATABASE_URL="postgresql://postgres:password@localhost:5432/bandolier"
```

You also need a cluster for agents to deploy into: **each user pastes their own kubeconfig** in the app's settings, or a repo admin configures a shared kubeconfig for a repo in its settings.

See [Configuration reference](#configuration-reference) for every variable.

### 4. Start Postgres and apply the schema

```bash
./start-database.sh     # starts a Postgres container from DATABASE_URL
pnpm db:push            # creates the tables (no migration files are used)
```

### 5. Run the app

```bash
pnpm dev
```

Open <http://localhost:3000> and sign in with GitHub.

### 6. Configure your account in the app

Open **Settings** in the dashboard and add:

- **A model provider** — either AWS Bedrock credentials or an Anthropic API key. Credentials are validated before they're saved, and the model picker is populated live from whichever provider you configured.
- **A kubeconfig** — the cluster your agents deploy into (a repo can also provide a shared one).

You can now select a repo, deploy an agent, and watch it work.

---

## The agent harness image

Agent Jobs run a built-in default image, `ghcr.io/based64god/bandolier-agent-harness:latest` (built and pushed by `.github/workflows/agent-harness-image.yml` on pushes to `main` and version tags). Pods always pull it (`imagePullPolicy: Always`).

To run a custom build, set a per-repo **agent image** override in the repo's settings. Because pods always pull, the image must be pushed to a registry the cluster can reach:

```bash
docker build -t <your-registry>/bandolier-agent-harness:latest agent-harness
docker push <your-registry>/bandolier-agent-harness:latest
```

`agent-harness/k8s/manifest.yaml` is a standalone reference Job you can apply directly to test the image in isolation; the running app generates equivalent Jobs itself and does not use that file.

---

## GitHub App (optional)

To have agents launch automatically when issues are opened, install the Bandolier GitHub App:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps). Give it a webhook URL of `https://<your-host>/api/webhooks/github`, a webhook secret, and these repository permissions: **Issues** (read & write), **Pull requests** (read & write), **Contents** (read), **Metadata** (read). Subscribe to the **Issues** event. Generate a private key.
2. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped), and `GITHUB_WEBHOOK_SECRET` (the App's webhook secret) in the app's environment. Optionally set `NEXT_PUBLIC_GITHUB_APP_SLUG` so the repo-config UI links to the App's install page.
3. Install the App on the repos you want Bandolier to act on. The App delivers events automatically — there's no per-repo webhook to add.

When an issue is opened, Bandolier verifies the App's signature, finds the Bandolier user linked to the GitHub account that opened it, and deploys an agent under that user's credentials — so clone/push and the resulting PR are attributed to the issue author. The "Bando picked up this issue…" comment is posted by the App itself (as `bandolier[bot]`), not the user.

Optional env knobs: `GITHUB_TRIGGER_LABEL` (only act on issues carrying a specific label) and, per repo, a trigger phrase that issue text must contain (set in the repo-config UI). `BANDOLIER_GITHUB_TOKEN` is a deprecated fallback used for the bot comment only when the App is not configured.

---

## REST API (optional)

Besides the dashboard, agents can be listed and launched over a small REST API under `/api/v1`, authenticated with an API key (create one in the app; the token is shown once and only its hash is stored):

```bash
# List tasks for a repo
curl -H "Authorization: Bearer bnd_…" \
  https://<your-host>/api/v1/repos/<owner>/<repo>/tasks

# Launch a task
curl -X POST -H "Authorization: Bearer bnd_…" -H "Content-Type: application/json" \
  -d '{"task":"Fix the flaky test in auth.spec.ts"}' \
  https://<your-host>/api/v1/repos/<owner>/<repo>/tasks
```

---

## Configuration reference

All server configuration is validated in `src/env.js`.

### Required

| Variable                           | Description                                                     |
| ---------------------------------- | --------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`               | Secret for signing sessions and tokens. Required in production. |
| `BETTER_AUTH_GITHUB_CLIENT_ID`     | GitHub OAuth app client ID.                                     |
| `BETTER_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret.                                 |
| `DATABASE_URL`                     | PostgreSQL connection string.                                   |

### Common

| Variable             | Default                 | Description                                              |
| -------------------- | ----------------------- | -------------------------------------------------------- |
| `BETTER_AUTH_URL`    | `http://localhost:3000` | Public base URL of the app.                              |
| `K8S_LABEL_SELECTOR` | `app=bandolier-agent`   | Label selector identifying Bandolier-managed agent pods. |

The harness image (`ghcr.io/based64god/bandolier-agent-harness:latest`, always pulled) is a built-in default, overridable per repo in repo settings. The agent namespace is derived from the repo (default `bandolier-agents`). Neither is configured via environment variables.

### Agent isolation

| Variable                     | Default         | Description                                                                                                                                                    |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_NETWORK_POLICY`       | `true`          | Apply a `NetworkPolicy` denying inbound and limiting egress to DNS + the public internet. Needs a policy-enforcing CNI (Calico/Cilium); a no-op under kindnet. |
| `AGENT_EGRESS_BLOCKED_CIDRS` | RFC-1918 ranges | Comma-separated CIDRs agents cannot reach (blocks lateral movement to in-cluster services).                                                                    |

### GitHub App / webhooks

| Variable                                            | Description                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                                     | Numeric id of the Bandolier GitHub App. Required (with the key) for bot-voice actions and event delivery.                                                                  |
| `GITHUB_APP_PRIVATE_KEY`                            | The App's PEM private key (`\n`-escaped). Used to mint installation tokens for bot comments.                                                                               |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | The App's OAuth credentials. Optional until login is moved to the App.                                                                                                     |
| `NEXT_PUBLIC_GITHUB_APP_SLUG`                       | The App's public slug, used to link the repo-config UI to its install page.                                                                                                |
| `GITHUB_WEBHOOK_SECRET`                             | Secret for verifying webhook signatures. With the GitHub App, set this to the App's webhook secret (delivery is app-level — there are no per-repo secrets).                |
| `GITHUB_TRIGGER_LABEL`                              | If set, only act on issues that carry this label.                                                                                                                          |
| `BANDOLIER_GITHUB_TOKEN`                            | **Deprecated** — superseded by the GitHub App. OAuth/PAT for a dedicated bot user, used for the "Bando picked up this issue…" comment only when the App is not configured. |

### Access gate (optional)

| Variable       | Description                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_PASSWORD` | When set, a shared password is required before reaching any page or API (webhooks and the REST API are exempt — they authenticate on their own). |

### Run artifacts (optional)

Setting `ARTIFACTS_S3_BUCKET` enables uploading each run's transcript to S3 so it survives the Job's one-week TTL.

| Variable                                                          | Default     | Description                                                            |
| ----------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `ARTIFACTS_S3_BUCKET`                                             | _(unset)_   | Enables artifact persistence when set.                                 |
| `ARTIFACTS_S3_REGION`                                             | `us-east-1` | Bucket region.                                                         |
| `ARTIFACTS_S3_ENDPOINT`                                           | _(unset)_   | Custom endpoint for MinIO / S3-compatible stores.                      |
| `ARTIFACTS_AWS_ACCESS_KEY_ID` / `ARTIFACTS_AWS_SECRET_ACCESS_KEY` | _(unset)_   | Explicit S3 credentials; falls back to the default AWS provider chain. |

---

## Project layout

```
src/
  app/                       Next.js App Router
    dashboard/_components/    The agent dashboard UI (deploy, monitor, settings, webhooks)
    api/auth/[...all]/        Better Auth handler
    api/webhooks/github/      GitHub issue → agent webhook
    api/agent-runs/           Transcript ingest endpoint (harness → S3)
    api/v1/                   REST API
  server/
    api/routers/              tRPC routers (agents, repos, account, models, webhooks, api-keys)
    agents/                   Job creation, kubeconfig, model listing, credentials, artifacts
    better-auth/              Auth configuration
    db/schema.ts              Drizzle schema (users, credentials, task runs, API keys, webhooks)
  proxy.ts                   Middleware implementing the optional password gate

agent-harness/
  cmd/harness/main.go        The Go binary that runs inside each agent pod
  Dockerfile                 Harness image (Go binary + Node + Claude Code CLI + git/gh)
  k8s/manifest.yaml          Standalone reference Job for testing the image
```

---

## Scripts

| Command                                   | What it does                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`                                | Run the app in development (Turbopack).                                    |
| `pnpm build` / `pnpm start`               | Production build / serve.                                                  |
| `pnpm db:push`                            | Sync the Drizzle schema to the database (used instead of migration files). |
| `pnpm db:studio`                          | Open Drizzle Studio.                                                       |
| `pnpm typecheck`                          | `tsc --noEmit`.                                                            |
| `pnpm lint` / `pnpm lint:fix`             | ESLint.                                                                    |
| `pnpm format:write` / `pnpm format:check` | Prettier.                                                                  |
| `pnpm check`                              | Lint + typecheck together.                                                 |
| `pnpm test`                               | Run the unit-test suite once (Vitest).                                     |
| `pnpm test:watch`                         | Run Vitest in watch mode.                                                  |
| `pnpm test:coverage`                      | Run the suite and emit a coverage report under `coverage/`.                |

---

## Tests

Two suites cover the project's pure logic — fast, hermetic, and free of any
database, network, or Kubernetes access:

- **Web app (Vitest).** Unit tests live next to the code they cover as
  `*.test.ts` files under `src/`. They exercise the parsing, validation,
  formatting, and crypto-token helpers — AWS-credential parsing, the password
  gate and artifact-ingest tokens, issue-prompt and branch-name building,
  Kubernetes namespace/label derivation, model selection, and the REST
  response mapping. Run them with `pnpm test` (or `pnpm test:coverage`).

- **Agent harness (Go).** `agent-harness/cmd/harness/main_test.go` covers the
  harness's pure helpers — slugging, branch naming, prompt building, PR-content
  parsing, issue-closing keyword handling, provider detection, and tool-use
  rendering. Run them with `go test ./...` from `agent-harness/`.

Both suites run in CI on every push and pull request (see
`.github/workflows/ci.yml`).

---

## Security notes

- **Per-user credentials.** Agents only ever run with the deploying (or issue-opening) user's own GitHub, model-provider, and cluster credentials. There is no server-side provider identity to fall back on.
- **Per-job secrets.** A run's credentials live in a Kubernetes Secret owned by its Job, so they're deleted when the Job is (manually or via its TTL). Finished Jobs are retained for one week.
- **Stored credentials are not encrypted at rest.** User AWS/Anthropic keys and kubeconfigs are stored in Postgres in plaintext; API key tokens are stored only as SHA-256 hashes. The GitHub App private key and webhook secret live in the app's environment, not the database. Protect the database accordingly and serve the app over HTTPS.
- **Network isolation** for agent pods is on by default but requires a policy-enforcing CNI to take effect.

---

## Tech stack

Next.js (App Router) · React · tRPC · Better Auth (GitHub OAuth) · Drizzle ORM + PostgreSQL · Tailwind CSS · `@kubernetes/client-node` · AWS SDK (Bedrock/STS/S3) · Go (agent harness).
