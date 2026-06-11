import { readFileSync } from "node:fs";
import { join } from "node:path";

// Serves the kubeconfig generator so users can run it without checking out the
// repo:  curl -fsSL https://<host>/setup.sh | bash
//
// The script is the same single source of truth used locally
// (scripts/create-bandolier-kubeconfig.sh). It's read at build time and served
// as a static asset — it contains no secrets, so it's exempt from the password
// gate (see src/proxy.ts).
export const dynamic = "force-static";

const script = readFileSync(
  join(process.cwd(), "scripts", "create-bandolier-kubeconfig.sh"),
  "utf8",
);

export function GET() {
  return new Response(script, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
