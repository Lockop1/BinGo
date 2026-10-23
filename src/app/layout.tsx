import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Patrick_Hand, Permanent_Marker } from "next/font/google";
import { SessionProvider } from "@/components/providers/SessionProvider";
import "./globals.css";

// Pencil (lobby / paper screens), marker (Whiteboard theme), scoreboard (Dark Scoreboard theme).
const pencil = Patrick_Hand({ variable: "--font-pencil", weight: "400", subsets: ["latin"] });
const marker = Permanent_Marker({ variable: "--font-marker", weight: "400", subsets: ["latin"] });
const scoreboard = Bebas_Neue({ variable: "--font-scoreboard", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Bingo Night",
  description: "Activity bingo for a night out with friends.",
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
      </body>
    </html>
  );
}
