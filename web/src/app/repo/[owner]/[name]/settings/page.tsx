import { redirect } from "next/navigation";

import { getSession } from "~/server/better-auth/server";
import { api, HydrateClient } from "~/trpc/server";
import { RepoSettingsPage } from "./_components/repo-settings-page";

export const metadata = { title: "Repo settings — Bandolier" };

// Repo-scoped settings, /repo/{owner}/{name}/settings. More specific than the
// /repo/[...slug] dashboard catch-all, so it wins for the /settings suffix.
export default async function RepoSettings({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = await params;
  const repoFullName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;

  const session = await getSession();
  if (!session) redirect("/");

  // Prefetch the default panel's (general) config query so the page streams
  // down with data — inputs must mirror the useQuery calls exactly. The other
  // panels' queries fire lazily when opened. Admin authorization happens in
  // the procedure; a non-admin gets the error surfaced client-side.
  void api.webhooks.getConfig.prefetch({ repoFullName });

  return (
    <HydrateClient>
      <RepoSettingsPage repoFullName={repoFullName} />
    </HydrateClient>
  );
}
