import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

// Placeholder UI font. Theme fonts (pencil, marker, scoreboard) arrive in Phase 5.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bingo Night",
  description: "Activity bingo for a night out with friends.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
