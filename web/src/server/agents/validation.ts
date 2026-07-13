/**
 * The result of validating a credential or config: `valid: true` — optionally
 * carrying provider-specific details for the success case (an STS ARN, a
 * cluster version, …) via `T` — or `valid: false` with a human-readable reason.
 *
 * A discriminated union so a `valid` check narrows the extra fields: after
 * `if (!v.valid)` the `error` is a plain `string`, and in the success branch
 * `T`'s fields are available. Replaces the per-provider `{ valid; error? }`
 * shapes that used to be copied into every validator module.
 */
export type Validation<T = object> =
  | ({ valid: true } & T)
  | { valid: false; error: string };

/**
 * Validates an API key with a cheap GET against a provider's models endpoint:
 * `200` → valid, `401` → invalid key, any other status → a generic provider
 * error. Shared by the Anthropic and OpenAI key checks, which are identical
 * apart from the URL and auth headers.
 */
export async function probeApiKey(
  url: string,
  headers: Record<string, string>,
  providerName: string,
): Promise<Validation> {
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return { valid: true };
    if (res.status === 401)
      return { valid: false, error: "API key is invalid." };
    return { valid: false, error: `${providerName} API error: ${res.status}` };
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error
          ? err.message
          : `Could not reach ${providerName} API.`,
    };
  }
}
