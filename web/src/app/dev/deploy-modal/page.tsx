"use client";

import { useState } from "react";

import { DeployModal } from "~/app/dashboard/_components/deploy-modal";
import { api, type RouterOutputs } from "~/trpc/react";

/**
 * Dev-only harness that mounts DeployModal in isolation, so the deploy form can
 * be exercised in a real browser — e.g. with Playwright. Not linked from the
 * app.
 *
 * The modal fires four tRPC queries on mount (providerInfo, deployDefaults,
 * repos.issues, models.list). Rather than stand up a backend, we prime the
 * React Query cache with fixtures for each scenario before mounting the modal;
 * because the seeded data is fresh (within staleTime), the modal reads it from
 * cache and never hits the network. The one request the modal makes on its own
 * — the deploy mutation on submit — is left for a spec to intercept.
 */
type Scenario = "repo" | "repo-creds" | "no-provider";

const REPO = "acme/widgets";

type ProviderInfo = RouterOutputs["agents"]["providerInfo"];
type Models = RouterOutputs["models"]["list"]["models"];

const PROVIDER_INFO: Record<Scenario, ProviderInfo> = {
  repo: { provider: "anthropic", region: null, source: "user" },
  "repo-creds": { provider: "anthropic", region: null, source: "repo" },
  "no-provider": { provider: "none", region: null, source: "none" },
};

const MODELS: Record<Scenario, Models> = {
  repo: [
    {
      id: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      provider: "anthropic",
      auth: "api_key",
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      provider: "anthropic",
      auth: "api_key",
    },
    { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", auth: "api_key" },
  ],
  "repo-creds": [
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      provider: "anthropic",
      auth: "api_key",
    },
  ],
  "no-provider": [],
};

const ISSUES: RouterOutputs["repos"]["issues"] = [
  {
    number: 235,
    title: "e2e coverage gaps",
    url: "https://github.com/acme/widgets/issues/235",
    body: "The e2e suite has two gaps.",
  },
  {
    number: 240,
    title: "flaky status badge popover",
    url: "https://github.com/acme/widgets/issues/240",
    body: "The popover sometimes closes on its own.",
  },
];

const PULLS: RouterOutputs["repos"]["pulls"] = [
  {
    number: 128,
    title: "Add retry to the deploy poller",
    url: "https://github.com/acme/widgets/pull/128",
  },
  {
    number: 131,
    title: "Fix status badge popover flicker",
    url: "https://github.com/acme/widgets/pull/131",
  },
];

const DEFAULTS: RouterOutputs["agents"]["deployDefaults"] = {
  maxTurns: 40,
  compute: { cpu: "2", memory: "4Gi" },
};

export default function DeployModalHarness() {
  const utils = api.useUtils();
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [deployed, setDeployed] = useState("");
  const [closes, setCloses] = useState(0);

  // Prime the tRPC cache for a scenario, then mount the modal. Seeding on the
  // click (an event, not an effect) means the data is in the cache before the
  // modal's mount queries run, so they read the fixtures instead of fetching.
  const open = (id: Scenario) => {
    utils.agents.providerInfo.setData(
      { repoFullName: REPO },
      PROVIDER_INFO[id],
    );
    utils.agents.deployDefaults.setData({ repoFullName: REPO }, DEFAULTS);
    utils.repos.issues.setData({ repoFullName: REPO }, ISSUES);
    utils.repos.pulls.setData({ repoFullName: REPO }, PULLS);
    utils.models.list.setData({ repoFullName: REPO }, { models: MODELS[id] });
    setDeployed("");
    setScenario(id);
  };

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const scenarios: { id: Scenario; label: string }[] = [
    { id: "repo", label: "Repo (user creds)" },
    { id: "repo-creds", label: "Repo credentials" },
    { id: "no-provider", label: "No provider" },
  ];

  return (
    <div className="min-h-screen space-y-4 bg-[#06140c] p-8 text-white">
      <h1 className="text-lg">DeployModal harness</h1>
      <div className="flex flex-wrap gap-2">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`open-${s.id}`}
            onClick={() => open(s.id)}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            {s.label}
          </button>
        ))}
      </div>

      <p data-testid="deployed" className="font-mono text-sm">
        {deployed || "none"}
      </p>
      <p data-testid="closes" className="font-mono text-sm">
        {closes}
      </p>

      {scenario && (
        <DeployModal
          key={scenario}
          namespace="default"
          repoFullName={REPO}
          onClose={() => {
            setCloses((c) => c + 1);
            setScenario(null);
          }}
          onDeployed={(t) => setDeployed(`${t.jobName}|${t.displayName}`)}
        />
      )}
    </div>
  );
}
