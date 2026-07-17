import Link from "next/link";

import { BandolierIcon } from "~/app/_components/bandolier-icon";
import { LidDemo } from "~/app/close-the-lid/_components/lid-demo";

const title = "Close the lid — Bandolier";
const description =
  "Stop leaving your MacBook open for the agents. Run them on Kubernetes and go outside.";

export const metadata = {
  title,
  description,
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary_large_image", title, description },
};

// Light-hearted marketing page. It leans on one running gag — the ritual of
// leaving your laptop cracked open overnight so your coding agent keeps going —
// and ribs the two labs everyone's agents are secretly made of. All in good
// fun; Bandolier itself runs on Claude.
export default function CloseTheLidPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-20 px-6 py-20 sm:py-28">
        {/* Hero */}
        <section className="flex flex-col items-center gap-6 text-center">
          <BandolierIcon className="h-14 w-14" />
          <p className="text-xs font-medium tracking-[0.3em] text-purple-300 uppercase">
            Bandolier presents
          </p>
          <h1 className="text-4xl font-extrabold tracking-tight text-balance sm:text-6xl">
            Close the lid.
          </h1>
          <p className="max-w-xl text-lg text-balance text-white/60 sm:text-xl">
            Your agents don&apos;t need your MacBook cracked open on the kitchen
            counter at 2&nbsp;a.m. Run them on Kubernetes and go to bed like a
            person.
          </p>
        </section>

        {/* Interactive gag */}
        <section className="w-full">
          <LidDemo />
        </section>

        {/* The ritual */}
        <section className="flex flex-col gap-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            You know the ritual.
          </h2>
          <p className="text-white/60">
            Screen brightness all the way down. A little app jiggling the mouse
            so the thing never sleeps. The lid propped open just a crack, like
            you&apos;re incubating an egg. You tell yourself you&apos;ll close
            it once the agent finishes the refactor. It is now Tuesday.
          </p>
          <ul className="flex flex-col gap-3 text-white/70">
            {[
              "Left it open on the counter — spouse unimpressed.",
              "Booked a middle seat so the agent could keep its Wi-Fi.",
              "Explained to airport security why the laptop must stay awake.",
              "Named the caffeine app in your will.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-purple-400" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="text-white/60">
            Bandolier deploys the agent to a cluster, streams the logs to your
            phone, and lets you shut the laptop like the year is 2015.
            Revolutionary.
          </p>
        </section>

        {/* The labs */}
        <section className="flex w-full flex-col gap-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            The frontier labs, ranked by us
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <blockquote className="rounded-xl border border-white/10 bg-white/5 p-5">
              <p className="text-sm text-white/70">
                &ldquo;We&apos;re only two weeks from AGI.&rdquo;
              </p>
              <footer className="mt-3 text-xs tracking-wide text-white/40 uppercase">
                OpenAI, every fortnight since 2022
              </footer>
            </blockquote>
            <blockquote className="rounded-xl border border-white/10 bg-white/5 p-5">
              <p className="text-sm text-white/70">
                &ldquo;Have you considered the safety implications of you going
                to sleep?&rdquo;
              </p>
              <footer className="mt-3 text-xs tracking-wide text-white/40 uppercase">
                Anthropic, gently, at length
              </footer>
            </blockquote>
            <blockquote className="rounded-xl border border-purple-400/30 bg-purple-500/10 p-5">
              <p className="text-sm text-white/80">
                &ldquo;Just run the thing somewhere that isn&apos;t your
                lap.&rdquo;
              </p>
              <footer className="mt-3 text-xs tracking-wide text-purple-300/70 uppercase">
                Bandolier, touching grass
              </footer>
            </blockquote>
          </div>
          <p className="text-sm text-white/50">
            OpenAI will rename this feature four times before lunch. Anthropic
            will publish a 40-page paper on whether the lid <em>consents</em>
            {" to being closed. Bandolier just closed it. "}
            You&apos;re welcome.
          </p>
        </section>

        {/* CTA */}
        <section className="flex flex-col items-center gap-6 text-center">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Deploy an agent. Close a laptop.
          </h2>
          <p className="max-w-md text-white/60">
            Point Bandolier at a repo, kick off the work, and walk away. The
            cluster doesn&apos;t sleep so you can.
          </p>
          <Link
            href="/"
            className="rounded-full bg-purple-600 px-8 py-3 font-semibold text-black transition hover:bg-purple-500"
          >
            Try Bandolier
          </Link>
          <p className="text-xs text-white/30">
            No MacBooks were kept awake in the making of this page.
          </p>
        </section>
      </div>
    </main>
  );
}
