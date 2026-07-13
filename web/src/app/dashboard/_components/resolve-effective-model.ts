import type { ModelOption } from "~/server/agents/models";

// Picker option key. A model can be offered once per credential kind (a user
// with both an API key and a subscription sees e.g. "claude-opus-4-8" twice),
// so options are keyed by id + auth rather than the bare id.
export function modelKey(m: { id: string; auth?: string }): string {
  return m.auth ? `${m.id}::${m.auth}` : m.id;
}

export interface ResolvedModel {
  /** Option KEY (id + credential kind) of the effective model; "" if none. */
  effectiveKey: string;
  /** The resolved model option, or null when nothing is available. */
  selected: ModelOption | null;
  /** Whether the effective model matches the stored per-browser preference. */
  isPreferred: boolean;
  /**
   * The bare model id to send to the server. Prefers the resolved option's id;
   * falls back to stripping the credential kind off the key for the rare case
   * where the key names a model no longer in the list.
   */
  submitId: string;
}

/**
 * Derives the effective model from the picker's explicit choice and the user's
 * stored preference. Precedence for the default (when there's no explicit
 * choice): the preferred model (if still available), else a Sonnet, else the
 * first available model.
 *
 * Selection is tracked by option KEY (id + credential kind), not bare id — the
 * same model can be offered once per credential kind, and the key disambiguates
 * "run on my API key" from "run on my subscription". A legacy stored preference
 * may be a bare id, so it's resolved by id as a fallback.
 */
export function resolveEffectiveModel(
  models: ModelOption[],
  explicit: string,
  preferred: string,
): ResolvedModel {
  const preferredOption =
    models.find((m) => modelKey(m) === preferred) ??
    models.find((m) => m.id === preferred);
  const fallbackOption =
    models.find((m) => /sonnet/i.test(m.id) || /sonnet/i.test(m.label)) ??
    models[0];
  const defaultModel = preferredOption
    ? modelKey(preferredOption)
    : fallbackOption
      ? modelKey(fallbackOption)
      : "";
  const effectiveKey = explicit || defaultModel;
  const selected = models.find((m) => modelKey(m) === effectiveKey) ?? null;
  const isPreferred =
    !!selected &&
    (modelKey(selected) === preferred || selected.id === preferred);
  const submitId = selected?.id ?? effectiveKey.split("::")[0]!;
  return { effectiveKey, selected, isPreferred, submitId };
}
