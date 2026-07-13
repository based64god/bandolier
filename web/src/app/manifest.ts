import { type MetadataRoute } from "next";

// Brand colors shared with the favicon (src/app/icon.svg) and apple-icon.
const BACKGROUND = "#000000";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bandolier",
    short_name: "Bandolier",
    description: "Claude agent monitoring & deployment on Kubernetes",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    orientation: "any",
    // Reuse an already-open Bandolier window when a captured link launches the
    // PWA instead of spawning a fresh window at start_url.
    launch_handler: {
      client_mode: "navigate-existing",
    },
    // Declares the installed PWA as the preferred handler for in-scope links so
    // links to bandolier.dev open in the app rather than the browser. Spread so
    // it survives Next's Manifest type, which doesn't model handle_links yet.
    ...({ handle_links: "preferred" } as const),
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
