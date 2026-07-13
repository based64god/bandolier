export interface ParsedAws {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
}

// Maps the various key spellings AWS uses (env vars and credentials-file keys)
// to our fields.
const FIELD_ALIASES: Record<string, keyof ParsedAws> = {
  aws_access_key_id: "accessKeyId",
  aws_secret_access_key: "secretAccessKey",
  aws_session_token: "sessionToken",
  aws_security_token: "sessionToken",
  aws_region: "region",
  aws_default_region: "region",
  region: "region",
};

/**
 * Parses an AWS credentials block pasted in any common format:
 *   - `export AWS_ACCESS_KEY_ID="..."` (shell exports)
 *   - `set AWS_ACCESS_KEY_ID=...` / `$env:AWS_ACCESS_KEY_ID="..."`
 *   - `aws_access_key_id = ...` (credentials-file / ini, with optional [profile])
 * Returns whichever fields were found. Returns null if nothing matched, so the
 * caller can tell a credential paste from ordinary typing.
 */
export function parseAwsCredentials(text: string): ParsedAws | null {
  const result: ParsedAws = {};

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("[") || line.startsWith("#")) continue;

    // Strip shell/PowerShell prefixes.
    line = line
      .replace(/^export\s+/i, "")
      .replace(/^set\s+/i, "")
      .replace(/^\$env:/i, "");

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes and any trailing semicolon.
    value = value.replace(/;$/, "").trim();
    value = value.replace(/^["']|["']$/g, "");

    const field = FIELD_ALIASES[key];
    if (field && value) result[field] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}
