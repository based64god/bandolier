import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import type { Validation } from "~/server/agents/validation";

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

/**
 * Which AWS call produced the error, selecting the action-specific wording and
 * fallback below: STS `GetCallerIdentity` (credential validation), Bedrock model
 * listing, or an S3 write.
 */
export type AwsErrorContext = "sts" | "bedrock" | "s3";

// Error names whose cause and wording are the same whichever call surfaced them,
// so every context gets them for free. A context can still override any entry.
const SHARED_AWS_MESSAGES: Record<string, string> = {
  SignatureDoesNotMatch:
    "Secret access key doesn't match the access key ID — check for a typo or copy/paste error.",
};

interface AwsContextMapping {
  /** Action-specific messages; override the shared table for the same name. */
  overrides: Record<string, string>;
  /** Message when the error name is unmapped and carries no message of its own. */
  fallback: string;
}

const AWS_CONTEXT_MAPPINGS: Record<AwsErrorContext, AwsContextMapping> = {
  sts: {
    overrides: {
      ExpiredToken: "Credentials have expired.",
      ExpiredTokenException: "Credentials have expired.",
      InvalidClientTokenId:
        "Access key ID is not recognized by AWS — it may be disabled, deleted, mistyped, or from a different account.",
      AccessDenied: "Credentials are valid but not authorized for this action.",
      AccessDeniedException:
        "Credentials are valid but not authorized for this action.",
    },
    fallback: "Credentials are invalid.",
  },
  bedrock: {
    overrides: {
      ExpiredToken: "AWS credentials have expired. Update them in settings.",
      ExpiredTokenException:
        "AWS credentials have expired. Update them in settings.",
      InvalidSignatureException:
        "AWS credentials are invalid. Check them in settings.",
      UnrecognizedClientException:
        "AWS credentials are invalid. Check them in settings.",
      AccessDeniedException:
        "AWS credentials lack permission to list Bedrock models (bedrock:ListInferenceProfiles / ListFoundationModels).",
    },
    fallback: "Failed to query AWS Bedrock models.",
  },
  s3: {
    overrides: {
      NoSuchBucket:
        "The bucket does not exist — check the name, region, and endpoint.",
      InvalidAccessKeyId:
        "Access key ID is not recognized — it may be disabled, deleted, or mistyped.",
      AccessDenied:
        "Credentials are valid but not allowed to write to this bucket — grant s3:PutObject on it.",
      PermanentRedirect:
        "The bucket lives in a different region than the one given.",
    },
    fallback: "Could not write to the bucket.",
  },
};

/**
 * Maps an AWS SDK error to a message that names the real cause, worded for the
 * `context` that hit it. AWS's raw wording ("The security token included in the
 * request is invalid") misleadingly implies a session-token problem even for
 * plain long-term keys, so known error names get a clearer message; unknown ones
 * fall back to the error's own message, then a context-specific default.
 */
export function friendlyAwsError(
  err: unknown,
  context: AwsErrorContext,
): string {
  const e = (err ?? {}) as { name?: string; message?: string };
  const mapping = AWS_CONTEXT_MAPPINGS[context];
  if (e.name) {
    const mapped = mapping.overrides[e.name] ?? SHARED_AWS_MESSAGES[e.name];
    if (mapped) return mapped;
  }
  return e.message ?? mapping.fallback;
}

/**
 * The result of validating AWS credentials: on success the caller's ARN and
 * account from STS GetCallerIdentity, on failure a human-readable reason.
 */
export type AwsValidation = Validation<{
  /** The caller ARN when valid (e.g. arn:aws:iam::123:user/foo). */
  arn?: string;
  account?: string;
}>;

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
    return { valid: false, error: friendlyAwsError(err, "sts") };
  } finally {
    client.destroy();
  }
}
