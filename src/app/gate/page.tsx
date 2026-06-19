import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { safeFrom } from "~/lib/gate";

export const metadata = { title: "Bandolier" };

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const { from, error } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#04210f] to-black p-4 text-white">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4">
          <BandolierIcon className="h-14 w-14 text-purple-300" />
          <h1 className="text-3xl font-extrabold tracking-tight">Bandolier</h1>
        </div>

        <form
          action="/api/gate"
          method="POST"
          className="flex w-full flex-col gap-3"
        >
          <input type="hidden" name="from" value={safeFrom(from)} />
          <input
            type="password"
            name="password"
            required
            autoFocus
            placeholder="Password"
            aria-label="Password"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
          />
          {error && <p className="text-xs text-red-400">Incorrect password.</p>}
          <button
            type="submit"
            className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-black hover:bg-purple-500"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
