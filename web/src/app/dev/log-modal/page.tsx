"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { LogModal } from "~/app/dashboard/_components/log-modal";

/**
 * Dev-only harness mounting the full LogModal so its header controls can be
 * exercised in a real browser (Playwright). The log query has no cluster to
 * reach here and simply errors — the header (including the Retrigger control a
 * Failed/cancelled task gets, next to the close ✕) renders regardless.
 *
 * The task status is read from `?status=` (default "Failed") so the spec can
 * check that the retrigger control appears only for a finished, failed run. Not
 * linked from the app.
 */
export default function LogModalHarness() {
  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <Suspense>
      <Harness />
    </Suspense>
  );
}

function Harness() {
  const status = useSearchParams().get("status") ?? "Failed";
  const [retriggered, setRetriggered] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-neutral-950 p-8 text-white">
      <p data-testid="retriggered">{retriggered ?? "none"}</p>
      <LogModal
        podName="bandolier-agent-000"
        namespace="bandolier-dev"
        jobName="bandolier-agent-000"
        status={status}
        prompt="Fix the failing test in src/index.ts"
        tokens={null}
        onClose={() => undefined}
        onRetriggered={(jobName) => setRetriggered(jobName)}
      />
    </div>
  );
}
