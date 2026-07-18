"use client";

import { api } from "~/trpc/react";
import { usedAgoLabel } from "./agent-ui";
import { ProviderTag } from "./provider-tag";

/** One recently-used provider credential, as the query returns it. */
export interface CredentialUsage {
  provider: string;
  /** Catalog label for a gollm-proxied provider; ignored for first-class ones. */
  label: string;
  lastUsedAt: Date | string;
}

// The presentational strip: one badge per recently-used provider with a
// relative "used …" timestamp. Pure (data in, markup out) so it renders in the
// dev harness without tRPC. Renders nothing when nothing's been used recently,
// keeping the footer clean for new users.
export function CredentialUsageList({ usage }: { usage: CredentialUsage[] }) {
  if (usage.length === 0) return null;

  return (
    <div
      data-testid="credential-usage"
      className="flex flex-wrap items-center justify-center gap-2"
    >
      <span className="text-xs text-white/30">Recently used</span>
      {usage.map((u) => (
        <span
          key={u.provider}
          data-testid={`credential-usage-${u.provider}`}
          title={`Last used ${usedAgoLabel(u.lastUsedAt)}`}
          className="flex items-center gap-1.5"
        >
          <ProviderTag provider={u.provider} label={u.label} />
          <span className="text-[10px] text-white/30">
            {usedAgoLabel(u.lastUsedAt)}
          </span>
        </span>
      ))}
    </div>
  );
}

// Footer indicator: the model-provider credentials this user has run an agent
// on recently (last 7 days), newest first. Covers every gollm-supported
// provider — the four first-class ones and any gollm-proxied "gollm:<id>".
export function CredentialUsageIndicators() {
  const { data: usage } = api.account.recentCredentialUsage.useQuery(
    undefined,
    // Cheap DB read; refresh on roughly the task-list cadence so a badge appears
    // shortly after a deploy without a manual reload.
    { refetchInterval: 30_000 },
  );

  return <CredentialUsageList usage={usage ?? []} />;
}
