import {
  removeInstallation,
  upsertInstallation,
} from "~/server/agents/github-app";
import { db } from "~/server/db";

import { type InstallationPayload } from "./types";

/**
 * Maintains the repo → installation mapping from the App's `installation` and
 * `installation_repositories` events. Both deliver the same shape; the action
 * distinguishes adds from removes:
 *   - created / added   → record the listed repos under this installation
 *   - deleted / removed → drop the listed repos (or all, on a full uninstall)
 */
export async function handleInstallation(
  payload: InstallationPayload,
  fullUninstall: boolean,
): Promise<void> {
  const installationId = String(payload.installation.id);
  const accountLogin = payload.installation.account?.login ?? null;

  const added = payload.repositories ?? payload.repositories_added ?? [];
  for (const repo of added) {
    await upsertInstallation(db, repo.full_name, installationId, accountLogin);
  }

  const removed = payload.repositories_removed ?? [];
  for (const repo of removed) {
    await removeInstallation(db, repo.full_name);
  }

  // A full uninstall carries the installation's repo list under `repositories`;
  // those rows must be dropped, not added.
  if (fullUninstall) {
    for (const repo of payload.repositories ?? []) {
      await removeInstallation(db, repo.full_name);
    }
  }

  console.log("[bandolier:webhook] installation event processed", {
    action: payload.action,
    installation: installationId,
    added: added.length,
    removed:
      removed.length +
      (fullUninstall ? (payload.repositories?.length ?? 0) : 0),
  });
}
