"use client";

import { ClusterDeploySection } from "~/app/dashboard/_components/cluster-deploy-section";
import {
  SettingsCard,
  SettingsShell,
  type SettingsNavGroup,
} from "~/app/_components/settings-shell";
import { ApiKeysSection } from "./api-keys-section";
import { ComputeSection, KubeconfigSection } from "./infrastructure-sections";
import {
  AnthropicSection,
  AwsSection,
  GeminiSection,
  OpenAISection,
} from "./provider-sections";

const NAV: SettingsNavGroup[] = [
  {
    id: "providers",
    label: "Model providers",
    items: [
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "gemini", label: "Gemini" },
      { id: "aws", label: "AWS Bedrock" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    items: [
      { id: "cluster-deploy", label: "Cluster deploy" },
      { id: "kubeconfig", label: "Kubeconfig" },
      { id: "compute", label: "Agent compute" },
    ],
  },
  {
    id: "access",
    label: "Access",
    items: [{ id: "api-keys", label: "API keys" }],
  },
];

export function SettingsPage() {
  return (
    <SettingsShell
      title="Settings"
      backHref="/"
      backLabel="Dashboard"
      nav={NAV}
      defaultGroup="providers"
    >
      {(active) => (
        <>
          {active === "providers" && (
            <>
              <p className="text-xs text-white/40">
                Configure how your agents reach their model. For Claude, AWS
                Bedrock takes precedence when both are set; otherwise your
                Anthropic key is used. OpenAI keys and Gemini project
                credentials add their models to the picker alongside Claude —
                you choose per deploy. Credentials are verified before
                they&apos;re saved and again before each deploy.
              </p>
              <SettingsCard id="anthropic">
                <AnthropicSection />
              </SettingsCard>
              <SettingsCard id="openai">
                <OpenAISection />
              </SettingsCard>
              <SettingsCard id="gemini">
                <GeminiSection />
              </SettingsCard>
              <SettingsCard id="aws">
                <AwsSection />
              </SettingsCard>
            </>
          )}

          {active === "infrastructure" && (
            <>
              <p className="text-xs text-white/40">
                Where your agents run: spin up a managed cluster in one click,
                or bring your own with a kubeconfig, and set the default compute
                limits for deployed agents.
              </p>
              {/* ClusterDeploySection renders its own card. */}
              <section id="cluster-deploy" className="scroll-mt-20">
                <ClusterDeploySection />
              </section>
              <SettingsCard id="kubeconfig">
                <KubeconfigSection />
              </SettingsCard>
              <SettingsCard id="compute">
                <ComputeSection />
              </SettingsCard>
            </>
          )}

          {active === "access" && (
            <SettingsCard id="api-keys">
              <ApiKeysSection />
            </SettingsCard>
          )}
        </>
      )}
    </SettingsShell>
  );
}
