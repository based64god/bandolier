# Bandolier

[![CI](https://github.com/based64god/bandolier/actions/workflows/ci.yml/badge.svg)](https://github.com/based64god/bandolier/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbased64god%2Fbandolier%2Fbadges%2Fcoverage.json)](https://github.com/based64god/bandolier/actions/workflows/ci.yml)

Bandolier is a web app for running [Claude Code](https://www.anthropic.com/claude-code) agents as Kubernetes Jobs. You sign in with GitHub, point an agent at a repository or an issue, and Bandolier spins up an isolated pod that clones the repo, runs Claude Code non-interactively, and opens a pull request with the result. You watch progress live from a dashboard.

Agents can be launched two ways:

- **From the dashboard** — pick a repo, write a task (or select an open issue), choose a model, and deploy.
- **From a GitHub webhook** — when an issue is opened in a configured repo, Bandolier automatically launches an agent to work on it and open a PR.

Every agent runs with the **deploying user's own credentials** — their GitHub OAuth token, their model-provider credentials (an AWS Bedrock or Anthropic API key, or a Claude Pro/Max or ChatGPT subscription login), and the cluster from their kubeconfig. There are no shared, server-side provider credentials; the available models are queried live from each user's provider.

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

**Interactive sessions** work a little differently. Instead of a one-shot `claude --print`, the harness runs as a transparent proxy speaking the [Agent Client Protocol](https://agentclientprotocol.com) (ACP): it spawns `harness acp-agent` (an ACP server wrapping the Claude/Codex CLI over stdio) and relays JSON-RPC frames between it and the dashboard. The **dashboard is the ACP client** — it renders the agent's `session/update` stream (messages, tool calls) and sends follow-up prompts — while the harness keeps doing all the git/PR orchestration. Frames travel over the same outbound-only HTTP path as the rest of the pod's traffic (a small relay endpoint backed by Postgres), so this works the same whether Bandolier is on Vercel or self-hosted. One-shot (non-interactive) runs are unchanged.

```
Browser ──▶ Next.js app ──▶ Kubernetes API ──▶ Job (harness pod)
                │                                   │
                ├─ Postgres (users, creds, runs)    ├─ git clone
                └─ S3 (transcripts, optional)       ├─ claude --print
                                                    └─ gh pr create
```

---

## Prerequisites

- **Node.js 24** and **pnpm 11** (`corepack enable` picks up the pinned version).
- **Docker** or **Podman** — for the local Postgres database (and for building the harness image).
- **A PostgreSQL database** — the included script starts one in a container.
- **A Kubernetes cluster** the web app can reach and create Jobs in. For local development, [kind](https://kind.sigs.k8s.io/), [k3d](https://k3d.io/), or minikube all work. The cluster must be able to pull the harness image (see [The agent harness image](#the-agent-harness-image)).
- **A GitHub OAuth app** — for sign-in and repo access.
- **A model provider** — each user supplies their own credentials in the app: AWS Bedrock credentials, an Anthropic/OpenAI/Gemini API key, or a subscription login (a `claude setup-token` OAuth token for Claude Pro/Max, or `codex login`'s auth.json for ChatGPT). Nothing provider-related is needed in server config.

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
pnpm db:push            # syncs the schema straight to your local database
```

`db:push` is for local development only. Self-host deploys apply the checked-in
SQL migrations under `drizzle/` instead (via the migrator image, run as a Helm
hook). If you change `src/server/db/schema.ts`, run `pnpm db:generate` to emit a
new migration and commit it, or self-host upgrades won't pick up your change.

### 5. Run the app

```bash
pnpm dev
```

Open <http://localhost:3000> and sign in with GitHub.

### 6. Configure your account in the app

Open **Settings** in the dashboard and add:

- **A model provider** — AWS Bedrock credentials, an API key, or a subscription login. For Claude Pro/Max, run `claude setup-token` locally and paste the `sk-ant-oat01-…` token; for ChatGPT, run `codex login` locally and paste the contents of `~/.codex/auth.json`. API keys are validated before they're saved and the model picker is populated live from your provider; subscription credentials can't be probed via the API, so they get a static list of current models and are verified on the first run.
- **A kubeconfig** — the cluster your agents deploy into (a repo can also provide a shared one). Bandolier runs the Kubernetes client on its server, so exec-plugin kubeconfigs (the `aws`/`gcloud` credential plugins EKS/GKE emit) and ones that reference cert/key files on your laptop won't work — the server has neither those binaries nor those files. Generate a self-contained, token-based kubeconfig from your current cluster instead: `curl -fsSL https://<your-host>/setup.sh | bash` (hosted) or `./scripts/create-bandolier-kubeconfig.sh` (local checkout), then paste the output here. Add `--scoped` (e.g. `curl -fsSL https://<your-host>/setup.sh | bash -s -- --scoped`) to bind a least-privilege ClusterRole instead of cluster-admin.

You can now select a repo, deploy an agent, and watch it work.

---

## The agent harness image

Agent Jobs run a built-in default image, `ghcr.io/based64god/bandolier-agent-harness:latest` (built and pushed by `.github/workflows/agent-harness-image.yml` on pushes to `main` and version tags). Pods always pull it (`imagePullPolicy: Always`).

To run a custom build, set a per-repo **agent image** override in the repo's settings. Because pods always pull, the image must be pushed to a registry the cluster can reach:

```bash
docker build -t <your-registry>/bandolier-agent-harness:latest agent-harness
docker push <your-registry>/bandolier-agent-harness:latest
```

**Private registries.** If the override points at a **private `ghcr.io` package**, Bandolier pulls it automatically: at deploy time it attaches a short-lived `kubernetes.io/dockerconfigjson` image-pull Secret (owned by the Job, so it's garbage-collected with the run) to the agent pod, authenticated with the **triggering user's GitHub OAuth token**. GHCR does not accept GitHub App installation tokens, so the pull is attributed to the user who opened the issue / deployed the agent — the same identity used for clone, push, and PR authorship. This requires the user's OAuth grant to include the `read:packages` scope (Bandolier requests it at sign-in) and that user to have access to the package; the cluster otherwise needs no standing GHCR credentials. For private images on any **other** registry, configure the cluster's nodes (or the `bandolier-agent` ServiceAccount) with the appropriate pull credentials yourself; Bandolier only brokers GHCR.

`agent-harness/k8s/manifest.yaml` is a standalone reference Job you can apply directly to test the image in isolation; the running app generates equivalent Jobs itself and does not use that file.

**The self-host image.** A second agent image, `ghcr.io/based64god/bandolier-self-host:latest` (built by `.github/workflows/self-host-image.yml`, layered on `bandolier-agent-harness`), exists for **dogfooding**: it adds the Go and Node toolchains this repo builds with — plus Chromium and Playwright — so an agent can build, test, and run Bandolier itself rather than just drive other projects. Point a repo's agent-image override at it when the agent's task is working on Bandolier. See [`self-host/Dockerfile`](self-host/Dockerfile).

---

## Self-hosting on Kubernetes

The web app runs anywhere Node does — Vercel, a VM, or Kubernetes. To deploy the
**whole stack to a cluster**, this repo ships a production image and a Helm chart:

- **Web-app image** (`ghcr.io/based64god/bandolier`) — a lean Next.js standalone
  server, built from the repo-root `Dockerfile` and published by
  `.github/workflows/web-app-image.yml`. A companion **migrator image**
  (`ghcr.io/based64god/bandolier-migrate`) runs `drizzle-kit migrate`.
- **Helm chart** (`deploy/helm/bandolier`) — Deployment, Service, Ingress,
  config/secret wiring, a pre-install/pre-upgrade migration Job, health probes
  (`/api/health`), a choice of database (external, a bundled StatefulSet, or an
  operator-managed CloudNativePG cluster), and optional in-cluster MinIO for run
  artifacts.

```bash
helm upgrade --install bandolier deploy/helm/bandolier \
  --namespace bandolier --create-namespace \
  --set config.betterAuthUrl=https://bandolier.example.com \
  --set ingress.enabled=true --set ingress.host=bandolier.example.com \
  --set secrets.betterAuthSecret="$(openssl rand -base64 32)" \
  --set secrets.githubClientId=<id> --set secrets.githubClientSecret=<secret> \
  --set secrets.databaseUrl='postgresql://user:pass@host:5432/bandolier'
```

The web app is cluster-agnostic about where agents run (it uses each user's
kubeconfig), so it can live on the same cluster as its agents or a separate one;
its only hard dependency is Postgres. See **[`deploy/README.md`](deploy/README.md)**
for the full guide — quick start, production setup with external Postgres and
TLS, keeping secrets out of Helm values, and the config reference.

Don't have a cluster yet? **[`deploy/terraform/digitalocean`](deploy/terraform/digitalocean)**
provisions the whole stack on DigitalOcean with OpenTofu — a DOKS cluster,
managed Postgres, a Spaces bucket for run artifacts, optional DNS + Let's
Encrypt TLS — and installs the chart, in one `tofu apply`.

---

## GitHub App (optional)

To have agents launch automatically when issues are opened, install the Bandolier GitHub App:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps). Give it a webhook URL of `https://<your-host>/api/webhooks/github`, a webhook secret, and these repository permissions: **Issues** (read & write), **Pull requests** (read & write), **Contents** (read), **Actions** (read), and **Metadata** (read). Subscribe to the **Issues**, **Issue comment**, and **Workflow run** events. Issue comment powers resuming a run by commenting on its issue or PR, and drives the maintainer-approval flow for runs on shared repo credentials (see [Repository credentials and the maintainer gate](#repository-credentials-and-the-maintainer-gate)); Workflow run (with the Actions read permission) powers auto-resuming a run when a CI pipeline fails on the pull request it produced, for repos that opt into it in the repo config. Generate a private key. (Pulling private custom harness images from GHCR uses the triggering user's OAuth `read:packages` scope, not an App permission — see [The agent harness image](#the-agent-harness-image).)
2. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped), and `GITHUB_WEBHOOK_SECRET` (the App's webhook secret) in the app's environment. Optionally set `NEXT_PUBLIC_GITHUB_APP_SLUG` so the repo-config UI links to the App's install page.
3. Install the App on the repos you want Bandolier to act on. The App delivers events automatically — there's no per-repo webhook to add.

When an issue is opened, Bandolier verifies the App's signature, finds the Bandolier user linked to the GitHub account that opened it, and deploys an agent under that user's credentials — so clone/push and the resulting PR are attributed to the issue author. The "Bando picked up this issue…" comment is posted by the App itself (as `bandolier[bot]`), not the user.

The "Bando picked up this issue…" comment is posted exclusively via the App installation token, so it is always attributed to `bandolier[bot]`. On a repo where the App isn't installed there's no bot identity to comment as, so the comment is skipped rather than posted under a user or service token.

Optionally, each repo can set a trigger phrase that issue text must contain (set in the repo-config UI). When a trigger phrase is configured, **editing** an existing issue to newly include it launches an agent just as opening it would — so an issue that predates the phrase, or one the author fills in later, can still kick off a run. Only the edit that first introduces the phrase fires; later edits of an already-triggering issue don't re-run it.

### Resuming a run by commenting

Commenting on an issue or pull request that a run already worked on **resumes** it: Bandolier finds the item's most recent run, spawns a follow-up run under the commenter's credentials, and seeds it with the parent run's persisted transcript (when the repo has [artifact storage](#run-artifacts-optional) configured) so the agent picks up with full context of what was already done. While the parent's PR is still open, the follow-up works directly on its branch and pushes onto the same PR; otherwise it starts a fresh branch. Resumed tasks carry a "↻ resumed" chip in the dashboard naming their parent.

Comments from bots are ignored (including Bando's own acknowledgements), a comment only ever resumes — one with no prior run does nothing — and the repo's trigger phrase, when configured, applies to comments too.

---

## Repository system prompt (optional)

A repo admin can attach a **system prompt** to a repository in its settings (the repo-config UI). It's a blanket instruction — coding conventions, a review checklist, "always add tests", anything repo-wide — that Bandolier appends to the system prompt of **every** agent run for that repo: dashboard tasks, issue PRs, and webhook-triggered runs, across every model provider and both one-shot and interactive sessions.

It's layered _on top of_ Bandolier's own framing (the working agreement that lets the harness commit and open a PR), never replacing it, so you don't need to repeat the same guidance in each task. Leave it blank for none.

---

## Auto-merging Bandolier PRs (optional)

A repo admin can toggle **Auto-merge Bandolier PRs** in the repo-config UI. When on, every pull request a Bandolier run reports as its output has GitHub's native auto-merge enabled the moment the run finishes, so the PR merges itself once its required checks pass and it's mergeable — no human click. Auto-merge still honors the branch's protection rules (required reviews / status checks), so this only lands what the repo's own gates already allow; a branch with no protection would merge right away. The merge method is the first of merge / squash / rebase the repo permits. **Off by default** — it lets an agent's work merge without a human pressing the button, so enable it only when your branch protection is the gate you trust.

---

## Repository credentials and the maintainer gate

A repo admin can configure **shared repo-level credentials** (a kubeconfig and/or model-provider API keys) so everyone working on the repo runs on the same pooled infrastructure instead of each pasting their own. Because those credentials are shared — a run with them spends the repo's cluster and the repo's API keys — executing on them is restricted to GitHub users with **maintainer** access or higher on the repo. A run only counts as using shared credentials when it actually resolves to the repo's kubeconfig or model key (see the prefer-repo-credentials toggle); a user with their own credentials configured is never gated.

- **From the dashboard / REST API:** if your run would use the repo's shared credentials and you're not a maintainer, the deploy is rejected with a message telling you to ask a maintainer or configure your own credentials.
- **From a webhook (issue opened):** if the issue opener isn't a maintainer, the run is **held for approval** instead of dispatched. The bot comments on the issue asking a maintainer to approve. A maintainer-or-higher can then approve by either:
  - reacting 👍 (or 🚀) to the bot's approval comment, or
  - replying `/bando approve` (decline with `/bando decline`).

  On approval the held run is dispatched exactly as it was originally built, attributed to the issue opener. Approvals are one-shot and verified server-side — a non-maintainer's command or reaction is ignored. (GitHub doesn't deliver a webhook for reactions, so Bandolier re-checks the approval comment's reactions whenever a new comment lands on the issue; the `/bando approve` reply works immediately.)

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

# Read one task
curl -H "Authorization: Bearer bnd_…" \
  https://<your-host>/api/v1/repos/<owner>/<repo>/tasks/<id>

# Rename a task
curl -X PATCH -H "Authorization: Bearer bnd_…" -H "Content-Type: application/json" \
  -d '{"displayName":"New name"}' \
  https://<your-host>/api/v1/repos/<owner>/<repo>/tasks/<id>

# Terminate a task
curl -X DELETE -H "Authorization: Bearer bnd_…" \
  https://<your-host>/api/v1/repos/<owner>/<repo>/tasks/<id>
```

| Method   | Path                                          | Body                    | Purpose               |
| -------- | --------------------------------------------- | ----------------------- | --------------------- |
| `GET`    | `/api/v1/repos/{owner}/{repo}/tasks`          | —                       | List tasks for a repo |
| `POST`   | `/api/v1/repos/{owner}/{repo}/tasks`          | launch fields (below)   | Launch a task         |
| `GET`    | `/api/v1/repos/{owner}/{repo}/tasks/{id}`     | —                       | Read one task         |
| `PATCH`  | `/api/v1/repos/{owner}/{repo}/tasks/{id}`     | `{ "displayName": … }`  | Rename a task         |
| `DELETE` | `/api/v1/repos/{owner}/{repo}/tasks/{id}`     | —                       | Terminate a task      |

The launch endpoint accepts everything the dashboard's deploy dialog can set,
except interactive sessions (the REST API only starts one-shot runs). The body
is JSON; every field except `task`/`prompt` is optional:

| Field           | Type                                             | Default                         | Notes                                                                       |
| --------------- | ------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| `task`          | string                                           | `""`                            | The operator task, or additional context when `issueNumber` is set.         |
| `prompt`        | string                                           | —                               | Alias for `task` (used when `task` is omitted).                             |
| `branch`        | string                                           | the repo's default branch       | Branch to check out.                                                        |
| `model`         | string                                           | your provider's preferred model | A model id from one of your providers.                                      |
| `modelProvider` | `anthropic` \| `bedrock` \| `openai` \| `gemini` | primary-provider precedence     | Pins which provider serves `model` when several are configured.             |
| `modelAuth`     | `api_key` \| `subscription`                      | api-key-beats-subscription      | Pins the credential kind for providers where both are configured.           |
| `effort`        | `low` \| `medium` \| `high` \| `xhigh` \| `max`  | CLI default                     | Reasoning effort (Claude providers only; ignored otherwise).                |
| `maxTurns`      | integer ≥ 1                                      | unlimited                       | Caps the number of agent turns.                                             |
| `cpu`           | string                                           | repo/user default               | Per-task CPU limit as a Kubernetes quantity (e.g. `"2"`, `"500m"`).         |
| `memory`        | string                                           | repo/user default               | Per-task memory limit as a Kubernetes quantity (e.g. `"2Gi"`).              |
| `issueNumber`   | integer > 0                                      | —                               | Work on this GitHub issue; `task` becomes additional context.               |
| `outputType`    | `pr` \| `issue`                                  | `pr`                            | What the run produces: a pull request, or a new issue from a read-only run. |

You must provide a non-empty `task`/`prompt` or an `issueNumber`.

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

A repo admin can loosen these egress rules **per repository** from the repo
configuration modal (Network policy egress). Both toggles are **off by default**
— they only relax the baseline above:

- **Allow in-cluster (private) egress** — drops the `AGENT_EGRESS_BLOCKED_CIDRS`
  exclusion so the repo's agents can reach other pods and in-cluster services.
- **Allow all egress ports** — permits outbound TCP on any port instead of only
  80/443.

> ⚠️ **Security:** loosening egress weakens agent isolation. Agents run
> model-generated code with your credentials; in-cluster egress opens lateral
> movement and all-ports egress widens the exfiltration surface. Enable only for
> repos whose workloads you trust, and turn the toggles back off when done. The
> toggles take effect only when `AGENT_NETWORK_POLICY` is enabled and a
> policy-enforcing CNI is present; the policy is re-applied on each deploy, so a
> change applies to the next agent run.

### GitHub App / webhooks

| Variable                                            | Description                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                                     | Numeric id of the Bandolier GitHub App. Required (with the key) for bot-voice actions and event delivery.                                                   |
| `GITHUB_APP_PRIVATE_KEY`                            | The App's PEM private key (`\n`-escaped). Used to mint installation tokens for bot comments.                                                                |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | The App's OAuth credentials. Optional until login is moved to the App.                                                                                      |
| `NEXT_PUBLIC_GITHUB_APP_SLUG`                       | The App's public slug, used to link the repo-config UI to its install page.                                                                                 |
| `GITHUB_WEBHOOK_SECRET`                             | Secret for verifying webhook signatures. With the GitHub App, set this to the App's webhook secret (delivery is app-level — there are no per-repo secrets). |

### Access gate (optional)

| Variable       | Description                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_PASSWORD` | When set, a shared password is required before reaching any page or API (webhooks and the REST API are exempt — they authenticate on their own). |

### Run artifacts (optional)

Each run's full transcript can be uploaded to S3 so it survives the Job's one-week TTL. Storage is configured **per repository** in the repo-config modal (admin-only, under Shared credentials → Run artifact storage): the repo names an S3 bucket it owns (AWS or any S3-compatible endpoint such as MinIO) plus credentials scoped to it. There is deliberately no server-wide bucket — run data belongs to the repo, never the Bandolier operator — so runs for repos without a configured bucket (and runs with no repo) simply aren't persisted. The credentials stay server-side; they are never injected into agent pods.

This is independent of a run's **structured output** (the PR or issue URL), which is always persisted: the harness reports it to the app on completion and it's recorded on the run row, so a finished run's output stays recoverable from the database even when S3 isn't configured and the pod's logs are gone.

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

self-host/
  Dockerfile                 Dogfooding image: harness + Go/Node toolchains + Chromium/Playwright, for agents that build Bandolier itself

Dockerfile                   Web-app production image (Next.js standalone + migrator stages)
deploy/
  helm/bandolier/            Helm chart to self-host the web app on Kubernetes
  terraform/digitalocean/    OpenTofu: DOKS + managed Postgres + Spaces + the chart
  README.md                  Self-hosting-on-Kubernetes guide
```

---

## Scripts

| Command                                   | What it does                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`                                | Run the app in development (Turbopack).                                    |
| `pnpm build` / `pnpm start`               | Production build / serve.                                                  |
| `pnpm db:push`                            | Sync the Drizzle schema straight to the database (local development).      |
| `pnpm db:generate`                        | Emit a new SQL migration under `drizzle/` from schema changes.             |
| `pnpm db:migrate`                         | Apply the checked-in `drizzle/` migrations (what self-host deploys run).   |
| `pnpm db:studio`                          | Open Drizzle Studio.                                                       |
| `pnpm typecheck`                          | `tsc --noEmit`.                                                            |
| `pnpm lint` / `pnpm lint:fix`             | ESLint.                                                                    |
| `pnpm format:write` / `pnpm format:check` | Prettier.                                                                  |
| `pnpm check`                              | Lint + typecheck together.                                                 |
| `pnpm test`                               | Run the unit-test suite once (Vitest).                                     |
| `pnpm test:watch`                         | Run Vitest in watch mode.                                                  |
| `pnpm test:coverage`                      | Run the suite and emit a coverage report under `coverage/`.                |
| `pnpm test:e2e`                           | Run the Playwright browser smoke tests against the `/dev/*` harness routes. |

---

## Tests

Three suites cover the project. The first two exercise the pure logic — fast,
hermetic, and free of any database, network, or Kubernetes access; the third
drives the UI components in a real browser against inert harness routes:

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

- **Browser smoke tests (Playwright).** `e2e/*.spec.mjs` drive the UI
  components — the composer, conversation view, credential UI, effort picker,
  modal, searchable select, status badge, and task row — in a real Chromium
  against the `/dev/*` harness routes, which contact no real services.
  `e2e/run.mjs` boots `next dev`, waits for the routes, then runs each spec.
  This suite needs a browser, so install one first with
  `pnpm exec playwright install chromium` (add `--with-deps` on Linux to also
  fetch the system libraries), then run `pnpm test:e2e`. Set `E2E_BASE_URL` to
  reuse an already-running server instead of having the runner boot its own.

All three suites run in CI on every push and pull request (see
`.github/workflows/ci.yml`).

---

## Contributing

Before pushing, run the full verification loop — `pnpm check`, `pnpm test`,
`pnpm test:e2e`, and `go test ./...` (from `agent-harness/`). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the details, plus the cross-language
wire-contract rule and notes on `patches/` and `skills-lock.json`.

---

## Security notes

- **Per-user credentials.** Agents only ever run with the deploying (or issue-opening) user's own GitHub, model-provider, and cluster credentials. There is no server-side provider identity to fall back on.
- **Shared repo credentials require maintainer access.** When a repo configures shared credentials (a kubeconfig or model key) and a run would actually use them, only GitHub users with maintainer access or higher may execute. Dashboard/REST deploys by under-privileged users are rejected; webhook-triggered ones are held for a maintainer's approval. See [Repository credentials and the maintainer gate](#repository-credentials-and-the-maintainer-gate).
- **Per-job secrets.** A run's credentials live in a Kubernetes Secret owned by its Job, so they're deleted when the Job is (manually or via its TTL). Finished Jobs are retained for one week.
- **Stored credentials are not encrypted at rest.** User AWS/Anthropic keys and kubeconfigs are stored in Postgres in plaintext; API key tokens are stored only as SHA-256 hashes. The GitHub App private key and webhook secret live in the app's environment, not the database. Protect the database accordingly and serve the app over HTTPS.
- **Network isolation** for agent pods is on by default but requires a policy-enforcing CNI to take effect.

---

## Tech stack

Next.js (App Router) · React · tRPC · Better Auth (GitHub OAuth) · Drizzle ORM + PostgreSQL · Tailwind CSS · `@kubernetes/client-node` · AWS SDK (Bedrock/STS/S3) · Go (agent harness).
