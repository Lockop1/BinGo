import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: without this, a page served from the service worker cache never
  // hydrates in `next dev` (React debug channel waits for HMR data). Production
  // has no debug channel, so this only makes dev behave like prod for the PWA.
  experimental: { reactDebugChannel: false },
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
