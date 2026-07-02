import { SignInButton } from "~/app/_components/auth-buttons";
import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { AgentDashboard } from "~/app/dashboard/_components/agent-dashboard";
import { repoToNamespace } from "~/server/agents/namespace";
import { getSession } from "~/server/better-auth/server";
import { api, HydrateClient } from "~/trpc/server";

/**
 * Shared dashboard entry used by both the home route and the per-repo route.
 * `repoSlug` is the "owner/repo" selected via the URL (null on the home route).
 */
export async function DashboardEntry({
  repoSlug,
}: {
  repoSlug: string | null;
}) {
  const session = await getSession();

  if (!session) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-black text-white">
        <div className="flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4">
            <BandolierIcon className="h-16 w-16" />
            <div className="text-center">
              <h1 className="text-5xl font-extrabold tracking-[0.18em] uppercase">
                Bandolier
              </h1>
              <p className="mt-3 text-lg text-white/50">
                Claude agent monitoring &amp; deployment
              </p>
            </div>
          </div>
          <SignInButton />
        </div>
      </main>
    );
  }

  // Start the dashboard's initial queries on the server so the HTML streams
  // down with data instead of the client waterfalling them after hydration.
  // Inputs must mirror the useQuery calls in AgentDashboard/OverviewPanel
  // exactly, or the hydrated cache entries miss and the client refetches.
  void api.repos.list.prefetch();
  void api.account.kubeconfigStatus.prefetch({
    repoFullName: repoSlug ?? undefined,
  });
  if (repoSlug) {
    void api.agents.list.prefetch({
      namespace: repoToNamespace(repoSlug),
      repoFullName: repoSlug,
    });
  } else {
    // Home route renders the cross-repo overview instead of a repo's task
    // list. Without a kubeconfig the client never runs this query; the
    // prefetch just fails fast server-side and is dropped.
    void api.agents.overview.prefetch();
  }

  return (
    <HydrateClient>
      <AgentDashboard
        user={{ name: session.user.name, image: session.user.image }}
        repoSlug={repoSlug}
      />
    </HydrateClient>
  );
}
