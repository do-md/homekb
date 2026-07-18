import type { Metadata, Viewport } from "next";
// DOMD ships its rendering CSS (.DOMD-* rules: heading sizes, marker hiding, code
// blocks) as a separate export; import it before globals so .hk-domd can override.
import "@do-md/core-react/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "HomeKB",
  description: "Your knowledge base, with data stored on your own computer",
  manifest: "/manifest.webmanifest",
};

/**
 * PWA viewport per the known-good recipe (iOS standalone):
 * - viewportFit=cover is required for env(safe-area-inset-*) to be non-zero.
 * - maximumScale/userScalable lock pinch zoom so the installed app feels native.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    // Match the daisyUI theme's base-100 canvas so the iOS status-bar band blends in
    { media: "(prefers-color-scheme: light)", color: "#fcfcfc" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1e1e" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Both the legacy Apple key and the standard key: Next's appleWebApp may emit only the new one */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="HomeKB" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
