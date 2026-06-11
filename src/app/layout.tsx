import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

import { env } from "~/env";
import { TRPCReactProvider } from "~/trpc/react";

const title = "Bandolier";
const description = "Claude agent monitoring & deployment on Kubernetes";

export const metadata: Metadata = {
  metadataBase: new URL(env.BETTER_AUTH_URL),
  title,
  description,
  applicationName: "Bandolier",
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
      </body>
    </html>
  );
}
