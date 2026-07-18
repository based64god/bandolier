"use client";

import { api } from "~/trpc/react";
import { resetsInLabel, usageMeter, usedAgoLabel } from "./agent-ui";
import { ProviderTag } from "./provider-tag";

/** A subscription's rolling-window meter reading, as the query returns it. */
export interface CredentialUsageMeter {
  runs: number;
  budget: number;
  resetsAt: Date | string;
}

/** One recently-used provider credential, as the query returns it. */
export interface CredentialUsage {
  provider: string;
  /** Catalog label for a gollm-proxied provider; ignored for first-class ones. */
  label: string;
  /** "api_key" (metered) or "subscription" (rolling-window allowance). */
  authKind: string;
  lastUsedAt: Date | string;
  /** Present only for subscriptions; metered keys show a timestamp instead. */
  usage: CredentialUsageMeter | null;
}

// Bar fill by how close to maxed out the subscription is, so a nearly-spent
// allowance reads as pressure at a glance.
const METER_FILL: Record<"ok" | "warn" | "max", string> = {
  ok: "bg-emerald-400/70",
  warn: "bg-amber-400/80",
  max: "bg-red-400/80",
};

// A subscription badge: how close its rolling-window allowance is to maxed out,
// as a small meter with a percentage. The tooltip spells out the run count and
// when the window resets.
function SubscriptionUsage({ u }: { u: CredentialUsage }) {
  const { runs, budget, resetsAt } = u.usage!;
  const { pct, tone } = usageMeter(runs, budget);
  return (
    <span
      data-testid={`credential-usage-${u.provider}`}
      title={`${runs} of ${budget} runs this window · ${resetsInLabel(resetsAt)}`}
      className="flex items-center gap-1.5"
    >
      <ProviderTag provider={u.provider} auth="subscription" label={u.label} />
      <span
        data-testid={`credential-meter-${u.provider}`}
        className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10"
      >
        <span
          className={`block h-full rounded-full ${METER_FILL[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-[10px] tabular-nums text-white/30">{pct}%</span>
    </span>
  );
}

// A metered-key badge: when the credential was last used.
function MeteredUsage({ u }: { u: CredentialUsage }) {
  return (
    <span
      data-testid={`credential-usage-${u.provider}`}
      title={`Last used ${usedAgoLabel(u.lastUsedAt)}`}
      className="flex items-center gap-1.5"
    >
      <ProviderTag provider={u.provider} label={u.label} />
      <span className="text-[10px] text-white/30">
        {usedAgoLabel(u.lastUsedAt)}
      </span>
    </span>
  );
}

// The presentational strip: one badge per recently-used provider. Subscriptions
// report how close to maxed out their rolling-window allowance is; metered keys
// report when they were last used. Pure (data in, markup out) so it renders in
// the dev harness without tRPC. Renders nothing when nothing's been used
// recently, keeping the footer clean for new users.
export function CredentialUsageList({ usage }: { usage: CredentialUsage[] }) {
  if (usage.length === 0) return null;

  return (
    <div
      data-testid="credential-usage"
      className="flex flex-wrap items-center justify-center gap-2"
    >
      <span className="text-xs text-white/30">Recently used</span>
      {usage.map((u) =>
        u.authKind === "subscription" && u.usage ? (
          <SubscriptionUsage key={u.provider} u={u} />
        ) : (
          <MeteredUsage key={u.provider} u={u} />
        ),
      )}
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
