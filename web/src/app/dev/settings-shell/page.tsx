"use client";

import {
  SettingsShell,
  type SettingsNavGroup,
} from "~/app/_components/settings-shell";

/**
 * Dev-only harness that mounts the shared SettingsShell chrome in isolation
 * (no tRPC/auth) so the responsive nav — a horizontal top bar below md: — can
 * be exercised in a real browser, e.g. with Playwright to assert it never
 * overflows the viewport on narrow screens. Not linked from the app.
 */
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
    ],
  },
  {
    id: "network",
    label: "Network",
    items: [{ id: "network-policy", label: "Egress policy" }],
  },
];

export default function SettingsShellHarness() {
  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <SettingsShell
      title="Repo settings"
      titleAccessory={
        <code className="truncate rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
          some-organization/a-really-quite-long-repository-name-here
        </code>
      }
      backHref="/"
      backLabel="Dashboard"
      nav={NAV}
      defaultGroup="general"
    >
      {(active) => (
        <div data-testid="active-group" className="text-white">
          Active group: {active}
        </div>
      )}
    </SettingsShell>
  );
}
