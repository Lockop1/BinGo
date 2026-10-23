import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest (Next links it from every page automatically).
// Colors match the paper theme tokens in globals.css (--paper).
const PAPER = "#fbf8ef";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Bingo Night",
    short_name: "Bingo Night",
    description: "Activity bingo for a night out with friends.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: PAPER,
    theme_color: PAPER,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
