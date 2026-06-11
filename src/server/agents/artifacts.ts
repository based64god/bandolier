import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { env } from "~/env";

/** Whether run-artifact persistence is configured (a bucket is set). */
export function artifactsEnabled(): boolean {
  return !!env.ARTIFACTS_S3_BUCKET;
}

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: env.ARTIFACTS_S3_REGION,
    endpoint: env.ARTIFACTS_S3_ENDPOINT,
    // Path-style is safest for S3-compatible/MinIO endpoints.
    forcePathStyle: !!env.ARTIFACTS_S3_ENDPOINT,
    // Fall back to the default AWS credential chain when not given explicitly.
    credentials:
      env.ARTIFACTS_AWS_ACCESS_KEY_ID && env.ARTIFACTS_AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.ARTIFACTS_AWS_ACCESS_KEY_ID,
            secretAccessKey: env.ARTIFACTS_AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  return client;
}

/** S3 key for a run's rendered transcript. */
export function transcriptKey(jobName: string): string {
  return `runs/${jobName}/transcript.log`;
}

export async function putArtifact(
  key: string,
  body: string,
  contentType = "text/plain; charset=utf-8",
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.ARTIFACTS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getArtifact(key: string): Promise<string | null> {
  try {
    const res = await s3().send(
      new GetObjectCommand({ Bucket: env.ARTIFACTS_S3_BUCKET, Key: key }),
    );
    return (await res.Body?.transformToString()) ?? null;
  } catch {
    return null;
  }
}
