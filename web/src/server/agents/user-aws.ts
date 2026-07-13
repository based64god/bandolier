import { eq } from "drizzle-orm";

import type { AwsCredentials } from "~/server/agents/aws";
import { type db } from "~/server/db";
import { userAwsCredentials } from "~/server/db/schema";

/** Loads a user's stored AWS credentials, or null if none are configured. */
export async function getUserAwsCredentials(
  database: typeof db,
  userId: string,
): Promise<AwsCredentials | null> {
  const [row] = await database
    .select()
    .from(userAwsCredentials)
    .where(eq(userAwsCredentials.userId, userId))
    .limit(1);

  if (!row) return null;
  return {
    accessKeyId: row.accessKeyId,
    secretAccessKey: row.secretAccessKey,
    sessionToken: row.sessionToken,
    region: row.region,
  };
}
