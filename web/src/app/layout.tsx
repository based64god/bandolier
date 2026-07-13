import "~/styles/globals.css";

import { type Metadata, type Viewport } from "next";
import { Geist } from "next/font/google";

import { KonamiEasterEgg } from "~/app/_components/konami-easter-egg";
import { NavigationHistoryProvider } from "~/app/_components/navigation-history";
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
  // Extend the web view edge-to-edge so it fills the whole screen, including
  // the regions around a notch / Dynamic Island / home indicator. This is what
  // makes env(safe-area-inset-*) report non-zero values; without it the insets
  // are always 0 and the black bezel mask in globals.css would collapse. The
  // black-translucent iOS status bar (see metadata.appleWebApp) already puts
  // content under the status bar, so cover keeps both platforms consistent.
  viewportFit: "cover",
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
        {/* Re-apply the "1337 h4x0r mode" easter egg (see KonamiEasterEgg)
            before paint so a saved preference doesn't flash the default theme
            first. Runs synchronously during body parse. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('h4x0r')==='1')document.documentElement.classList.add('h4x0r')}catch(e){}`,
          }}
        />
        <TRPCReactProvider>
          <NavigationHistoryProvider>{children}</NavigationHistoryProvider>
        </TRPCReactProvider>
        <PwaRegister />
        <PullToRefresh />
        <UpdatePrompt />
        <KonamiEasterEgg />
      </body>
    </html>
  );
}
