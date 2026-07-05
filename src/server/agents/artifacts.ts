import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { friendlyAwsError } from "~/server/agents/aws";
import type { Validation } from "~/server/agents/validation";
import { type db } from "~/server/db";
import { loadRepoConfig } from "~/server/agents/webhook-config";

/**
 * A resolved artifact store: the bucket a run's artifacts are written to and
 * the credentials to reach it. Always a repo's own configured bucket — there
 * is deliberately no server-wide store, so run data only ever lands in storage
 * the repo controls. See `resolveArtifactStore`.
 */
export interface ArtifactStore {
  bucket: string;
  region: string;
  /** Custom endpoint for MinIO / S3-compatible stores; undefined = AWS S3. */
  endpoint?: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * A repo's configured artifact store from its config row, shaped like the
 * loader's result. Only usable as a set — bucket and both credential halves
 * are required (the mutation enforces this; a partial row maps to null rather
 * than a half-configured store). Exported (as a pure mapping) so it's testable
 * without a database.
 */
export function repoArtifactStore(row: {
  artifactsS3Bucket: string | null;
  artifactsS3Region: string | null;
  artifactsS3Endpoint: string | null;
  artifactsAccessKeyId: string | null;
  artifactsSecretAccessKey: string | null;
}): ArtifactStore | null {
  if (
    !row.artifactsS3Bucket ||
    !row.artifactsAccessKeyId ||
    !row.artifactsSecretAccessKey
  ) {
    return null;
  }
  return {
    bucket: row.artifactsS3Bucket,
    region: row.artifactsS3Region ?? "us-east-1",
    endpoint: row.artifactsS3Endpoint ?? undefined,
    credentials: {
      accessKeyId: row.artifactsAccessKeyId,
      secretAccessKey: row.artifactsSecretAccessKey,
    },
  };
}

/**
 * The artifact store for a run: the repo's own configured bucket, or null when
 * the repo hasn't configured one (artifact persistence disabled). There is no
 * server-wide fallback on purpose — run data belongs to the repo, so it only
 * ever lands in storage the repo controls. Runs without a repo are never
 * persisted.
 */
export async function resolveArtifactStore(
  database: typeof db,
  repoFullName: string | null,
): Promise<ArtifactStore | null> {
  if (!repoFullName) return null;
  const row = await loadRepoConfig(database, repoFullName);
  return row ? repoArtifactStore(row) : null;
}

function s3(store: ArtifactStore): S3Client {
  return new S3Client({
    region: store.region,
    endpoint: store.endpoint,
    // Path-style is safest for S3-compatible/MinIO endpoints.
    forcePathStyle: !!store.endpoint,
    credentials: store.credentials,
  });
}

/** S3 key for a run's rendered transcript. */
export function transcriptKey(jobName: string): string {
  return `runs/${jobName}/transcript.log`;
}

export async function putArtifact(
  store: ArtifactStore,
  key: string,
  body: string,
  contentType = "text/plain; charset=utf-8",
): Promise<void> {
  const client = s3(store);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  } finally {
    client.destroy();
  }
}

export async function getArtifact(
  store: ArtifactStore,
  key: string,
): Promise<string | null> {
  const client = s3(store);
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    return (await res.Body?.transformToString()) ?? null;
  } catch {
    return null;
  } finally {
    client.destroy();
  }
}

export type ArtifactStoreValidation = Validation;

/**
 * Validates an artifact store by writing (then best-effort deleting) a small
 * probe object. Probing the exact operation the ingest path performs —
 * s3:PutObject — avoids rejecting narrowly-scoped write-only credentials that
 * a HeadBucket/ListBucket check would.
 */
export async function validateArtifactStore(
  store: ArtifactStore,
): Promise<ArtifactStoreValidation> {
  const client = s3(store);
  const key = "bandolier/write-probe";
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: key,
        Body: "bandolier artifact-store write probe",
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    // Clean up the probe when the credentials also allow deletes; leaving it
    // behind is harmless for write-only credentials.
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: store.bucket, Key: key }),
      );
    } catch {
      // Ignore — write access is what matters.
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: friendlyAwsError(err, "s3") };
  } finally {
    client.destroy();
  }
}
