"use client";

import {
  SettingsCard,
  SettingsShell,
  type SettingsNavGroup,
} from "~/app/_components/settings-shell";
import { api } from "~/trpc/react";
import { RepoCredentialsPanel } from "./credentials-sections";
import {
  RepoDefaultComputeSection,
  RepoDefaultEffortSection,
  RepoDefaultModelSection,
} from "./defaults-sections";
import { GithubAppSection, RepoBehaviorSection } from "./general-sections";
import { RepoNetworkPolicySection } from "./network-policy-section";
import { RepoResumeSection } from "./toggles";

const NAV: SettingsNavGroup[] = [
  {
    id: "general",
    label: "General",
    items: [
      { id: "github-app", label: "GitHub App" },
      { id: "behavior", label: "Triggers & behavior" },
    ],
  },
  {
    id: "defaults",
    label: "Agent defaults",
    items: [
      { id: "webhook-defaults", label: "Webhook defaults" },
      { id: "compute", label: "Agent compute" },
      { id: "resume", label: "CI auto-resume" },
    ],
  },
  {
    id: "credentials",
    label: "Shared credentials",
    items: [
      { id: "kubeconfig", label: "Kubeconfig" },
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "gemini", label: "Gemini" },
      { id: "aws", label: "AWS Bedrock" },
      { id: "artifacts", label: "Artifact storage" },
      { id: "preference", label: "Credential preference" },
    ],
  },
  {
    id: "network",
    label: "Network",
    items: [{ id: "network-policy", label: "Egress policy" }],
  },
];

export function RepoSettingsPage({ repoFullName }: { repoFullName: string }) {
  // Every procedure behind this page requires repo admin, so key the access
  // gate off the config query and surface its FORBIDDEN error once, up front,
  // instead of letting each card fail on its own.
  const { error } = api.webhooks.getConfig.useQuery({ repoFullName });

  return (
    <SettingsShell
      title="Repo settings"
      titleAccessory={
        <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
          {repoFullName}
        </code>
      }
      backHref={`/repo/${repoFullName}`}
      backLabel="Dashboard"
      nav={NAV}
      defaultGroup="general"
    >
      {(active) =>
        error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error.message}
          </div>
        ) : (
          <>
            {active === "general" && (
              <>
                <p className="text-xs text-white/40">
                  Repository-level settings for this repo: when agents trigger,
                  the image they run on, and the system prompt they get. Event
                  delivery is handled by the Bandolier GitHub App — install it
                  on this repo rather than configuring a webhook by hand.
                </p>
                <SettingsCard id="github-app">
                  <GithubAppSection repoFullName={repoFullName} />
                </SettingsCard>
                <SettingsCard id="behavior">
                  <RepoBehaviorSection repoFullName={repoFullName} />
                </SettingsCard>
              </>
            )}

            {active === "defaults" && (
              <>
                <p className="text-xs text-white/40">
                  Defaults for agents run on this repo. The model and effort
                  apply to webhook-triggered runs; compute applies to every run.
                  Per-issue labels and per-task deploy options override all of
                  them.
                </p>
                <SettingsCard id="webhook-defaults">
                  <div className="space-y-5">
                    <RepoDefaultModelSection repoFullName={repoFullName} />
                    <RepoDefaultEffortSection repoFullName={repoFullName} />
                  </div>
                </SettingsCard>
                <SettingsCard id="compute">
                  <RepoDefaultComputeSection repoFullName={repoFullName} />
                </SettingsCard>
                <SettingsCard id="resume">
                  <RepoResumeSection repoFullName={repoFullName} />
                </SettingsCard>
              </>
            )}

            {active === "credentials" && (
              <RepoCredentialsPanel repoFullName={repoFullName} />
            )}

            {active === "network" && (
              <SettingsCard id="network-policy">
                <RepoNetworkPolicySection repoFullName={repoFullName} />
              </SettingsCard>
            )}
          </>
        )
      }
    </SettingsShell>
  );
}
