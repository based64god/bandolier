import "~/styles/globals.css";

import { type Metadata, type Viewport } from "next";
import { Geist } from "next/font/google";

import { PullToRefresh } from "~/app/_components/pull-to-refresh";
import { PwaRegister } from "~/app/_components/pwa-register";
import { UpdatePrompt } from "~/app/_components/update-prompt";
import { env } from "~/env";
import { TRPCReactProvider } from "~/trpc/react";

const title = "Bandolier";
const description = "Claude agent monitoring & deployment on Kubernetes";

// Brand background, shared with the manifest and icons. Jet black, like a CRT.
const THEME_COLOR = "#000000";

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

export const metadata: Metadata = {
  metadataBase: new URL(env.BETTER_AUTH_URL),
  title,
  description,
  applicationName: "Bandolier",
  // The web app manifest is provided by the file convention
  // (src/app/manifest.ts); Next.js injects <link rel="manifest"> automatically.
  appleWebApp: {
    capable: true,
    title,
    statusBarStyle: "black-translucent",
  },
  // Favicon and apple-touch icon are provided by file conventions
  // (src/app/icon.svg and src/app/apple-icon.tsx).
  openGraph: {
    title,
    description,
    siteName: "Bandolier",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable}`}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <PwaRegister />
        <PullToRefresh />
        <UpdatePrompt />
      </body>
    </html>
  );
}
