import { redirect } from "next/navigation";

import { getSession } from "~/server/better-auth/server";
import { api, HydrateClient } from "~/trpc/server";
import { SettingsPage } from "./_components/settings-page";

export const metadata = { title: "Settings — Bandolier" };

export default async function Settings() {
  const session = await getSession();
  if (!session) redirect("/");

  // Prefetch the default panel's (model providers) status queries so the page
  // streams down with data. Inputs must mirror the useQuery calls in the
  // section components exactly, or the hydrated cache entries miss and the
  // client refetches. The other panels' queries fire lazily when opened.
  void api.account.anthropicStatus.prefetch();
  void api.account.openaiStatus.prefetch();
  void api.account.geminiStatus.prefetch();
  void api.account.awsStatus.prefetch();

  return (
    <HydrateClient>
      <SettingsPage />
    </HydrateClient>
  );
}
