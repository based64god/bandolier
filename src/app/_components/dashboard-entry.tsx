import { SignInButton } from "~/app/_components/auth-buttons";
import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { AgentDashboard } from "~/app/dashboard/_components/agent-dashboard";
import { getSession } from "~/server/better-auth/server";
import { HydrateClient } from "~/trpc/server";

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
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#04210f] to-[#020a04] text-white">
        <div className="flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4">
            <BandolierIcon className="h-16 w-16 text-purple-300" />
            <div className="text-center">
              <h1 className="text-5xl font-extrabold tracking-tight">
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

  return (
    <HydrateClient>
      <AgentDashboard
        user={{ name: session.user.name, image: session.user.image }}
        repoSlug={repoSlug}
      />
    </HydrateClient>
  );
}
