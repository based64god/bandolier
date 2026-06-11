import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  region: string;
}

/**
 * Normalizes a session token: empty/whitespace becomes undefined so permanent
 * credentials are never sent with a blank token (which AWS rejects).
 */
export function cleanSessionToken(
  token: string | null | undefined,
): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

// Maps STS error codes to messages that name the real cause. AWS's raw wording
// ("The security token included in the request is invalid") misleadingly implies
// a session-token problem even for plain long-term keys.
function friendlyError(name?: string, message?: string): string {
  switch (name) {
    case "ExpiredToken":
    case "ExpiredTokenException":
      return "Credentials have expired.";
    case "InvalidClientTokenId":
      return "Access key ID is not recognized by AWS — it may be disabled, deleted, mistyped, or from a different account.";
    case "SignatureDoesNotMatch":
      return "Secret access key doesn't match the access key ID — check for a typo or copy/paste error.";
    case "AccessDenied":
    case "AccessDeniedException":
      return "Credentials are valid but not authorized for this action.";
    default:
      return message ?? "Credentials are invalid.";
  }
}

export interface AwsValidation {
  valid: boolean;
  /** The caller ARN when valid (e.g. arn:aws:iam::123:user/foo). */
  arn?: string;
  account?: string;
  /** Human-readable reason when invalid. */
  error?: string;
}

/**
 * Validates AWS credentials by calling STS GetCallerIdentity. This confirms the
 * keys exist, are active, and — crucially for temporary/STS credentials — that
 * the session token hasn't expired. Cheap, read-only, and requires no IAM perms.
 */
export async function validateAwsCredentials(
  creds: AwsCredentials,
): Promise<AwsValidation> {
  const client = new STSClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: cleanSessionToken(creds.sessionToken),
    },
    maxAttempts: 1,
  });

  try {
    const res = await client.send(new GetCallerIdentityCommand({}));
    return { valid: true, arn: res.Arn, account: res.Account };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { valid: false, error: friendlyError(e.name, e.message) };
  } finally {
    client.destroy();
  }
}
