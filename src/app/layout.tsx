import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Patrick_Hand, Permanent_Marker } from "next/font/google";
import { AnalyticsProvider } from "@/components/providers/AnalyticsProvider";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import "./globals.css";

// Pencil (lobby / paper screens), marker (Whiteboard theme), scoreboard (Dark Scoreboard theme).
const pencil = Patrick_Hand({ variable: "--font-pencil", weight: "400", subsets: ["latin"] });
const marker = Permanent_Marker({ variable: "--font-marker", weight: "400", subsets: ["latin"] });
const scoreboard = Bebas_Neue({ variable: "--font-scoreboard", weight: "400", subsets: ["latin"] });

// An unset or empty NEXT_PUBLIC_APP_URL must never crash the root layout.
function safeBaseUrl(value: string | undefined): URL {
  try {
    return new URL(value && value.trim() ? value.trim() : "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const metadata: Metadata = {
  // Absolute base for Open Graph image URLs; /g/[code] also sets it per route.
  metadataBase: safeBaseUrl(process.env.NEXT_PUBLIC_APP_URL),
  title: "Bingo Night",
  description: "Activity bingo for a night out with friends.",
  applicationName: "Bingo Night",
  icons: {
    // favicon.ico (16 + 32 PNGs) for every browser, the SVG master where supported.
    // All generated from public/icons/logo.svg by scripts/make-icons.mjs.
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/logo.svg", type: "image/svg+xml" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Bingo Night" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf8ef" },
    { media: "(prefers-color-scheme: dark)", color: "#33302a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${pencil.variable} ${marker.variable} ${scoreboard.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SessionProvider>{children}</SessionProvider>
        <ServiceWorkerRegistration />
        <AnalyticsProvider />
      </body>
    </html>
  );
}
