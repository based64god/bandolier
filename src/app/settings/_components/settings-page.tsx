"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { ClusterDeploySection } from "~/app/dashboard/_components/cluster-deploy-section";
import { ApiKeysSection } from "./api-keys-section";
import { ComputeSection, KubeconfigSection } from "./infrastructure-sections";
import {
  AnthropicSection,
  AwsSection,
  GeminiSection,
  OpenAISection,
} from "./provider-sections";

type GroupId = "providers" | "infrastructure" | "access";

// Sidebar structure: three purpose groups, each listing the cards its panel
// renders. Group and card ids double as URL hashes (/settings#kubeconfig), so
// every entry is deep-linkable; a card hash selects its group and scrolls.
const NAV: {
  id: GroupId;
  label: string;
  items: { id: string; label: string }[];
}[] = [
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

const GROUP_FOR_HASH = new Map<string, GroupId>(
  NAV.flatMap((g) => [
    [g.id, g.id] as const,
    ...g.items.map((i) => [i.id, g.id] as const),
  ]),
);

// A titled card on a settings panel. The id is the deep-link/scroll anchor;
// scroll-mt keeps the card clear of the sticky header when jumped to.
function SettingsCard({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:p-5"
    >
      {children}
    </section>
  );
}

export function SettingsPage() {
  const [active, setActive] = useState<GroupId>("providers");

  // The active group follows the URL hash — both on load (deep links) and on
  // every in-page anchor click, which fires hashchange. A card-level hash
  // (#kubeconfig) selects its group; the browser's own anchor scroll misses
  // when the card's panel wasn't mounted yet, so scroll explicitly once it is.
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.slice(1);
      const group = GROUP_FOR_HASH.get(hash);
      if (!group) return;
      setActive(group);
      if (hash !== group) {
        requestAnimationFrame(() => {
          document
            .getElementById(hash)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link href="/" className="transition hover:opacity-80">
              <BandolierIcon className="h-7 w-7 shrink-0" />
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
          >
            ← Dashboard
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-10 md:py-8">
        {/* Group tabs — a horizontal row below md:, a sidebar from md: up.
            The sidebar sticks below the sticky header while the panel
            scrolls; self-start keeps it its natural height (a flex child
            stretched to the column's full height has no room to stick). */}
        <nav className="flex gap-1 overflow-x-auto md:sticky md:top-20 md:w-52 md:shrink-0 md:flex-col md:gap-4 md:self-start">
          {NAV.map((group) => (
            <div key={group.id} className="md:space-y-1">
              <a
                href={`#${group.id}`}
                aria-current={active === group.id ? "page" : undefined}
                className={`block rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${
                  active === group.id
                    ? "bg-white/10 font-medium text-white"
                    : "text-white/50 hover:bg-white/5 hover:text-white"
                }`}
              >
                {group.label}
              </a>
              <ul className="hidden md:block">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      className="block rounded-lg py-1 pr-3 pl-6 text-xs text-white/40 hover:text-white"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Only the active group's panel mounts, so a panel's status queries
            don't fire until it's opened. */}
        <main className="min-w-0 flex-1 space-y-4">
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
        </main>
      </div>
    </div>
  );
}
