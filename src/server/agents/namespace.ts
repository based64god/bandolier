/**
 * Derives a valid Kubernetes namespace name from a GitHub repo full name.
 * "owner/my-repo" → "owner-my-repo"
 * Must be lowercase alphanumeric + hyphens, max 63 chars, no leading/trailing hyphens.
 */
export function repoToNamespace(fullName: string): string {
  return fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
