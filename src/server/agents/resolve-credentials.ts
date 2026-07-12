import { getUserAnthropicCredentials } from "~/server/agents/anthropic";
import type { AwsCredentials } from "~/server/agents/aws";
import {
  getRepoCustomProviders,
  getUserCustomProviders,
  mergeCustomProviders,
  type CustomProviderCredential,
} from "~/server/agents/custom-providers";
import { parseGollmProvider } from "~/server/agents/gollm-catalog";
import { getUserGeminiKey } from "~/server/agents/gemini";
import { getUserOpenaiCredentials } from "~/server/agents/openai";
import { getUserAwsCredentials } from "~/server/agents/user-aws";
import { getRepoCredentials } from "~/server/agents/webhook-config";
import type { db } from "~/server/db";

/** Which provider a set of credentials routes to. Kept here — the single source
 * of provider identity — so `~/server/agents/models` can alias its `ModelProvider`
 * to it rather than restate the union. Ordered most- to least-preferred in
 * `PROVIDERS` below. */
export type ProviderName = "bedrock" | "anthropic" | "openai" | "gemini";

/**
 * A provider a run can route to: the four first-class providers, or a
 * gollm-proxied one as `gollm:<id>` (see ~/server/agents/gollm-catalog). The
 * template form keeps the four-way switches exhaustive while letting model
 * options and deploy inputs carry any catalog provider.
 */
export type RunProviderName = ProviderName | `gollm:${string}`;

/** Optional credential kind, for providers that support both a metered API key
 * and a subscription login (Anthropic / OpenAI). */
export type AuthKind = "api_key" | "subscription";

/**
 * The six-field model-credential shape, provider-agnostic. Every place that
 * routes by provider — the picker, the deploy/webhook paths, the provider badge —
 * shares this shape so the fields can't drift apart. `ModelCredentials` adds a
 * `source` tag; `JobSpec`'s per-field credentials mirror it (with `aws` spelled
 * `awsCredentials`).
 */
export interface ProviderCredentials {
  aws: AwsCredentials | null;
  anthropicApiKey: string | null;
  anthropicOauthToken: string | null;
  openaiApiKey: string | null;
  codexAuthJson: string | null;
  geminiApiKey: string | null;
}

/**
 * A resolved set of model credentials. AWS Bedrock, an Anthropic key, and an
 * OpenAI key may all be present; callers that need a single provider apply the
 * provider precedence themselves (see `pickProvider` / `providerForCredentials`),
 * while the model picker lists every configured provider's models side by side.
 *
 * OpenAI is user-scoped only — there is no repo-shared OpenAI credential — so it
 * only ever appears on the user's own set.
 */
export interface ModelCredentials extends ProviderCredentials {
  /** Claude subscription OAuth token (`claude setup-token`) — user-scoped only. */
  anthropicOauthToken: string | null;
  /** ChatGPT-subscription auth.json (`codex login`) — user-scoped only. */
  codexAuthJson: string | null;
  /**
   * The gollm-proxied provider credentials (Groq, OpenRouter, vLLM, …) —
   * distinct providers from the four above. The user's own and a repo's shared
   * ones are merged into a union on whichever set wins (the winner per shared
   * id follows which set wins). Optional so hand-built test sets (and older
   * callers) stay valid; absent means none.
   */
  customProviders?: CustomProviderCredential[];
  /** Where the credentials came from — useful for logging / UI. */
  source: "user" | "repo" | "none";
}

/**
 * The ordered provider registry — the single definition of both the provider
 * precedence (Bedrock > Anthropic > OpenAI > Gemini) and which of the six
 * credential fields belong to each provider. Every provider-routing decision
 * derives from this list, so adding a provider means editing one place.
 */
export const PROVIDERS: readonly {
  name: ProviderName;
  /** Whether this provider's credentials are present in a set. */
  hasCredentials: (creds: Partial<ProviderCredentials>) => boolean;
  /** This provider's fields, extracted from a set (others left null). */
  select: (creds: Partial<ProviderCredentials>) => Partial<ProviderCredentials>;
}[] = [
  {
    name: "bedrock",
    hasCredentials: (c) => !!c.aws,
    select: (c) => ({ aws: c.aws ?? null }),
  },
  {
    name: "anthropic",
    hasCredentials: (c) => !!c.anthropicApiKey || !!c.anthropicOauthToken,
    select: (c) => ({
      anthropicApiKey: c.anthropicApiKey ?? null,
      anthropicOauthToken: c.anthropicOauthToken ?? null,
    }),
  },
  {
    name: "openai",
    hasCredentials: (c) => !!c.openaiApiKey || !!c.codexAuthJson,
    select: (c) => ({
      openaiApiKey: c.openaiApiKey ?? null,
      codexAuthJson: c.codexAuthJson ?? null,
    }),
  },
  {
    name: "gemini",
    hasCredentials: (c) => !!c.geminiApiKey,
    select: (c) => ({ geminiApiKey: c.geminiApiKey ?? null }),
  },
];

const NO_CREDENTIALS: ProviderCredentials = {
  aws: null,
  anthropicApiKey: null,
  anthropicOauthToken: null,
  openaiApiKey: null,
  codexAuthJson: null,
  geminiApiKey: null,
};

/**
 * The single provider a set routes to by precedence, or null when the set holds
 * no model credentials at all. `JobSpec`-shaped sets (with `aws` supplied as
 * `awsCredentials`) must be adapted to `ProviderCredentials` before calling.
 */
export function providerForCredentials(
  creds: Partial<ProviderCredentials>,
): ProviderName | null {
  return PROVIDERS.find((p) => p.hasCredentials(creds))?.name ?? null;
}

/** Whether a set carries any model credential at all. */
export function hasModelCredentials(
  creds: Partial<ProviderCredentials> & {
    customProviders?: CustomProviderCredential[];
  },
): boolean {
  return (
    providerForCredentials(creds) !== null ||
    (creds.customProviders?.length ?? 0) > 0
  );
}

/**
 * Resolves which model credentials an agent should use. The unit of choice is
 * the whole set (so a user's AWS keys are never mixed with a repo's Anthropic
 * key): when the repo prefers its own credentials and has some, the repo set
 * wins; otherwise the user's own set wins, falling back to the other when the
 * preferred side is empty.
 *
 * `repoFullName` is optional — omit it for repo-less contexts, which then only
 * consider the user's own credentials.
 */
export async function resolveModelCredentials(
  database: typeof db,
  userId: string,
  repoFullName?: string,
): Promise<ModelCredentials> {
  const userAws = await getUserAwsCredentials(database, userId);
  const userAnthropic = await getUserAnthropicCredentials(database, userId);
  const userOpenai = await getUserOpenaiCredentials(database, userId);
  const userGemini = await getUserGeminiKey(database, userId);
  // gollm-proxied providers are per-provider-id independent (unlike the four
  // first-class credentials, which move as a unit), so the repo's shared ones
  // and the user's own are merged into a union on BOTH sets — the winner per
  // shared id follows which set wins (user-preferred: user wins; repo-preferred:
  // repo wins). This keeps a repo's shared Groq key available even when the
  // user's first-class credentials win the set.
  const userCustom = await getUserCustomProviders(database, userId);
  const userHas =
    !!userAws ||
    !!userAnthropic.apiKey ||
    !!userAnthropic.oauthToken ||
    !!userOpenai.apiKey ||
    !!userOpenai.codexAuthJson ||
    !!userGemini;

  const repo = repoFullName
    ? await getRepoCredentials(database, repoFullName)
    : null;
  const repoCustom = repoFullName
    ? await getRepoCustomProviders(database, repoFullName)
    : [];
  const repoAws = repo?.aws ?? null;
  const repoAnthropic = repo?.anthropicApiKey ?? null;
  const repoOpenai = repo?.openaiApiKey ?? null;
  const repoGemini = repo?.geminiApiKey ?? null;
  const repoHas =
    !!repoAws ||
    !!repoAnthropic ||
    !!repoOpenai ||
    !!repoGemini ||
    repoCustom.length > 0;

  // AWS Bedrock, an Anthropic key, and a Claude subscription OAuth token are
  // all routes to the same (Claude) models with a precedence between them, so
  // they move as one unit: a repo set must never mix the repo's AWS with the
  // user's Anthropic (or vice versa). Subscription credentials are personal, so
  // repos only ever hold API keys.
  const repoHasClaude = !!repoAws || !!repoAnthropic;
  // Same for the OpenAI side: an API key and a ChatGPT auth.json are two routes
  // to the same models, so the repo's key must not mix with the user's auth.json.
  const repoHasOpenai = !!repoOpenai;

  const userSet: ModelCredentials = {
    aws: userAws,
    anthropicApiKey: userAnthropic.apiKey,
    anthropicOauthToken: userAnthropic.oauthToken,
    openaiApiKey: userOpenai.apiKey,
    codexAuthJson: userOpenai.codexAuthJson,
    geminiApiKey: userGemini,
    // User wins per shared provider id; the repo's shared gollm providers fill
    // the gaps so they stay available when the user's first-class set wins.
    customProviders: mergeCustomProviders(userCustom, repoCustom),
    source: userHas || userCustom.length > 0 ? "user" : "none",
  };
  const repoSet: ModelCredentials = {
    // Claude side as one coherent unit: the repo's Claude set when it has one,
    // else fall back to the user's whole Claude set — never a mix of the two.
    aws: repoHasClaude ? repoAws : userAws,
    anthropicApiKey: repoHasClaude ? repoAnthropic : userAnthropic.apiKey,
    anthropicOauthToken: repoHasClaude ? null : userAnthropic.oauthToken,
    // OpenAI side likewise; Gemini is a single-credential provider and falls
    // back to the user's own key on its own.
    openaiApiKey: repoHasOpenai ? repoOpenai : userOpenai.apiKey,
    codexAuthJson: repoHasOpenai ? null : userOpenai.codexAuthJson,
    geminiApiKey: repoGemini ?? userGemini,
    customProviders: mergeCustomProviders(repoCustom, userCustom),
    source: repoHas ? "repo" : "none",
  };

  if (repo?.preferRepoCredentials) {
    return repoHas ? repoSet : userSet;
  }
  return userHas ? userSet : repoSet;
}

/**
 * Collapses a credential set to a single primary provider for callers that need
 * one (webhook/REST deploys with no model picker, and the provider badge): AWS
 * Bedrock beats Anthropic credentials (API key or subscription OAuth token),
 * which beat OpenAI credentials (API key or ChatGPT auth.json). At most one
 * provider's fields are non-null. The interactive deploy path instead routes by
 * the provider of the model the user actually picked.
 */
export function pickProvider(creds: ModelCredentials): ProviderCredentials {
  const provider = PROVIDERS.find((p) => p.hasCredentials(creds));
  return { ...NO_CREDENTIALS, ...(provider?.select(creds) ?? {}) };
}

/**
 * Selects the exact credentials a single run will use, routing by the provider
 * of the model the user picked (`modelProvider`) and, for providers with two
 * credential kinds, the kind they pinned (`modelAuth`). This is the one place
 * the interactive-deploy, REST, and webhook paths share for that decision.
 *
 * `modelProvider` unset (programmatic clients with no picker) falls back to the
 * primary-provider precedence via `pickProvider`. `modelAuth` unset falls back
 * to the API-key-beats-subscription precedence. Returns the resolved provider
 * (null when the set is empty), the auth kind the run actually landed on (for
 * the two-kind providers), and the six credential fields with only the chosen
 * provider's populated.
 */
export function selectRunCredentials(
  resolved: ModelCredentials,
  opts: { modelProvider?: RunProviderName; modelAuth?: AuthKind } = {},
): ProviderCredentials & {
  provider: RunProviderName | null;
  authKind: AuthKind | null;
  /** The gollm-proxied credential the run uses, when routed to one. */
  customProvider: CustomProviderCredential | null;
} {
  // A gollm-proxied model routes to its stored credential and nothing else —
  // the four first-class fields stay empty so the pod gets exactly one
  // provider's secrets.
  const gollmId = opts.modelProvider
    ? parseGollmProvider(opts.modelProvider)
    : null;
  if (gollmId) {
    const customProvider =
      (resolved.customProviders ?? []).find((c) => c.provider === gollmId) ??
      null;
    return {
      ...NO_CREDENTIALS,
      provider: customProvider ? opts.modelProvider! : null,
      authKind: null,
      customProvider,
    };
  }

  // A picked provider wins; otherwise fall back to the primary-provider
  // precedence. `pickProvider` already zeroes the non-primary fields, so the
  // fallback also supplies the credentials for that provider.
  const primary = pickProvider(resolved);
  const provider =
    (opts.modelProvider as ProviderName | undefined) ??
    providerForCredentials(resolved) ??
    // A set holding only gollm-proxied credentials routes to the first one
    // (mirrors the primary-provider precedence for programmatic clients).
    (resolved.customProviders?.[0]
      ? (`gollm:${resolved.customProviders[0].provider}` as const)
      : null);
  if (typeof provider === "string" && provider.startsWith("gollm:")) {
    const gollmFallback =
      (resolved.customProviders ?? []).find(
        (c) => c.provider === parseGollmProvider(provider),
      ) ?? null;
    return {
      ...NO_CREDENTIALS,
      provider: gollmFallback ? provider : null,
      authKind: null,
      customProvider: gollmFallback,
    };
  }

  const wantSubscription = opts.modelAuth === "subscription";
  const wantApiKey = opts.modelAuth === "api_key";

  const aws = provider === "bedrock" ? (resolved.aws ?? primary.aws) : null;
  const anthropicApiKey =
    provider === "anthropic" && !wantSubscription
      ? (resolved.anthropicApiKey ?? primary.anthropicApiKey)
      : null;
  const anthropicOauthToken =
    provider === "anthropic" && !wantApiKey && !anthropicApiKey
      ? (resolved.anthropicOauthToken ?? primary.anthropicOauthToken)
      : null;
  const openaiApiKey =
    provider === "openai" && !wantSubscription
      ? (resolved.openaiApiKey ?? primary.openaiApiKey)
      : null;
  const codexAuthJson =
    provider === "openai" && !wantApiKey && !openaiApiKey
      ? (resolved.codexAuthJson ?? primary.codexAuthJson)
      : null;
  const geminiApiKey =
    provider === "gemini"
      ? (resolved.geminiApiKey ?? primary.geminiApiKey)
      : null;

  // The auth kind this actually landed on (the API key beats the subscription),
  // for the two-kind providers; null for Bedrock/Gemini and empty sets.
  const authKind: AuthKind | null =
    provider === "anthropic"
      ? anthropicApiKey
        ? "api_key"
        : anthropicOauthToken
          ? "subscription"
          : null
      : provider === "openai"
        ? openaiApiKey
          ? "api_key"
          : codexAuthJson
            ? "subscription"
            : null
        : null;

  return {
    provider,
    authKind,
    aws,
    anthropicApiKey,
    anthropicOauthToken,
    openaiApiKey,
    codexAuthJson,
    geminiApiKey,
    customProvider: null,
  };
}
