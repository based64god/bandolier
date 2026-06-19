import { type MetadataRoute } from "next";

// Brand colors shared with the favicon (src/app/icon.svg) and apple-icon.
const BACKGROUND = "#020a04";

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
