/*
 * Bingo Night service worker policy. Pure functions only: no listeners, no
 * caches, no network. Loaded by /sw.js with importScripts() and unit-tested in
 * src/lib/pwa/swPolicy.test.ts, which runs this exact file in a sandbox.
 *
 * The rule: cache only the app shell (same-origin page HTML, hashed build
 * assets, icons, fonts, the manifest). Game data never touches a cache: any
 * request to Supabase (auth, REST, Realtime, Storage, signed media URLs), any
 * /api route, any RSC/data request and every non-GET request goes straight to
 * the network and fails honestly when offline.
 */
(function (scope) {
  "use strict";

  // Bump when the caching rules or cache layout change; old caches are deleted on activate.
  var CACHE_VERSION = "v1";
  var CACHE_PREFIX = "bingo-";
  var CACHE_NAMES = {
    pages: CACHE_PREFIX + "pages-" + CACHE_VERSION,
    static: CACHE_PREFIX + "static-" + CACHE_VERSION,
    assets: CACHE_PREFIX + "assets-" + CACHE_VERSION,
  };
  // Upper bounds so the caches never grow without limit (oldest entries go first).
  var CACHE_LIMITS = {
    pages: 30,
    static: 300,
    assets: 60,
  };

  // Navigations wait this long for the network before a cached copy is shown.
  var NAVIGATION_TIMEOUT_MS = 3000;

  // Same-origin paths that are data, auth or server endpoints: never cached.
  var NEVER_CACHE_PATH_PREFIXES = [
    "/api/",
    "/auth/",
    "/rest/",
    "/realtime/",
    "/storage/",
    "/functions/",
    "/graphql/",
    "/_next/image",
    "/_next/webpack-hmr",
    "/_next/hmr",
    "/__nextjs",
  ];
  // The worker files themselves are always fetched fresh by the browser.
  var NEVER_CACHE_PATHS = ["/sw.js", "/sw-policy.js"];

  // Query parameters that mark a signed / tokenised URL.
  var SIGNED_URL_PARAMS = [
    "token",
    "signature",
    "sig",
    "x-amz-signature",
    "x-amz-credential",
    "x-goog-signature",
    "apikey",
    "access_token",
  ];

  // Request headers that mark an authenticated API or an RSC / router data request.
  var NEVER_CACHE_HEADERS = [
    "authorization",
    "apikey",
    "range",
    "rsc",
    "next-router-prefetch",
    "next-router-state-tree",
    "next-action",
  ];

  var FONT_EXTENSION = /\.(?:woff2?|ttf|otf)$/i;

  /**
   * Strategies:
   * - "navigation": network first, cached page after NAVIGATION_TIMEOUT_MS or when offline,
   *   inline offline page if nothing is cached.
   * - "cache-first": content-hashed, immutable build output (/_next/static in production).
   * - "network-first": /_next/static in development (file names are not content-hashed there).
   * - "stale-while-revalidate": icons, fonts, the web manifest.
   * - null: not handled by the worker at all (plain network, never cached).
   */
  var STRATEGY = {
    navigation: "navigation",
    cacheFirst: "cache-first",
    networkFirst: "network-first",
    staleWhileRevalidate: "stale-while-revalidate",
  };

  /** Reads the worker config from its own script URL (/sw.js?supabase=<origin>&dev=1). */
  function readConfig(scriptUrl) {
    var url = new URL(scriptUrl);
    var supabaseOrigin = null;
    var rawSupabase = url.searchParams.get("supabase");
    if (rawSupabase) {
      try {
        supabaseOrigin = new URL(rawSupabase).origin;
      } catch {
        supabaseOrigin = null;
      }
    }
    return {
      origin: url.origin,
      supabaseOrigin: supabaseOrigin,
      dev: url.searchParams.get("dev") === "1",
    };
  }

  function getHeader(request, name) {
    var headers = request && request.headers;
    if (!headers || typeof headers.get !== "function") return null;
    return headers.get(name);
  }

  function hasSignedParams(url) {
    var found = false;
    url.searchParams.forEach(function (_value, key) {
      if (SIGNED_URL_PARAMS.indexOf(key.toLowerCase()) !== -1) found = true;
    });
    return found;
  }

  function isNavigationRequest(request) {
    if (request.mode === "navigate") return true;
    // Older engines: a top-level document request that accepts HTML.
    var accept = getHeader(request, "accept") || "";
    return request.destination === "document" && accept.indexOf("text/html") !== -1;
  }

  /**
   * Picks the caching strategy for a request, or null when the request must go
   * straight to the network (and never into a cache).
   * `request` only needs { url, method, mode?, destination?, headers?: { get(name) } }.
   */
  function selectStrategy(request, config) {
    if (!request || typeof request.url !== "string") return null;
    if ((request.method || "GET").toUpperCase() !== "GET") return null;

    var url;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    // Supabase (auth / REST / Realtime / Storage / signed media) and every other origin.
    if (config.supabaseOrigin && url.origin === config.supabaseOrigin) return null;
    if (url.origin !== config.origin) return null;

    for (var h = 0; h < NEVER_CACHE_HEADERS.length; h++) {
      if (getHeader(request, NEVER_CACHE_HEADERS[h]) !== null) return null;
    }
    if (url.searchParams.has("_rsc")) return null;
    if (hasSignedParams(url)) return null;

    var path = url.pathname;
    if (NEVER_CACHE_PATHS.indexOf(path) !== -1) return null;
    for (var p = 0; p < NEVER_CACHE_PATH_PREFIXES.length; p++) {
      var prefix = NEVER_CACHE_PATH_PREFIXES[p];
      if (path === prefix.replace(/\/$/, "") || path.indexOf(prefix) === 0) return null;
    }

    if (isNavigationRequest(request)) return STRATEGY.navigation;

    if (path.indexOf("/_next/static/") === 0) {
      return config.dev ? STRATEGY.networkFirst : STRATEGY.cacheFirst;
    }
    if (path.indexOf("/icons/") === 0 || path === "/manifest.webmanifest" || FONT_EXTENSION.test(path)) {
      return STRATEGY.staleWhileRevalidate;
    }
    return null;
  }

  /** True when the worker may put this request in a cache at all. */
  function shouldCache(request, config) {
    return selectStrategy(request, config) !== null;
  }

  /** Which cache a strategy writes to. */
  function cacheNameFor(strategy) {
    if (strategy === STRATEGY.navigation) return CACHE_NAMES.pages;
    if (strategy === STRATEGY.cacheFirst || strategy === STRATEGY.networkFirst) return CACHE_NAMES.static;
    if (strategy === STRATEGY.staleWhileRevalidate) return CACHE_NAMES.assets;
    return null;
  }

  function cacheLimitFor(cacheName) {
    if (cacheName === CACHE_NAMES.pages) return CACHE_LIMITS.pages;
    if (cacheName === CACHE_NAMES.static) return CACHE_LIMITS.static;
    if (cacheName === CACHE_NAMES.assets) return CACHE_LIMITS.assets;
    return 0;
  }

  /**
   * Only complete, same-origin 200 responses are stored. Pages must be HTML and
   * must not be the end of a redirect (a redirected response cannot answer a
   * navigation). `response` needs { ok, status, type, redirected?, headers }.
   */
  function isCacheableResponse(response, strategy) {
    if (!response || !response.ok || response.status !== 200) return false;
    if (response.type !== "basic" && response.type !== "default") return false;
    var vary = (getHeader(response, "vary") || "").trim();
    if (vary === "*") return false;
    if (strategy === STRATEGY.navigation) {
      if (response.redirected) return false;
      var contentType = getHeader(response, "content-type") || "";
      if (contentType.indexOf("text/html") === -1) return false;
    }
    return true;
  }

  /** Cache key for a page: the URL without its fragment. */
  function pageCacheKey(rawUrl) {
    var url = new URL(rawUrl);
    url.hash = "";
    return url.href;
  }

  /** Our caches that are not current (left over from an older CACHE_VERSION). */
  function staleCacheNames(existingNames) {
    var current = [CACHE_NAMES.pages, CACHE_NAMES.static, CACHE_NAMES.assets];
    return existingNames.filter(function (name) {
      return name.indexOf(CACHE_PREFIX) === 0 && current.indexOf(name) === -1;
    });
  }

  /** Same-origin build assets referenced by a page's HTML (to warm the shell on install). */
  function extractShellAssetUrls(html, origin) {
    var found = {};
    var pattern = /["'(]((?:https?:\/\/[^"'()\s]+)?\/_next\/static\/[^"'()\s\\]+)/g;
    var match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        var url = new URL(match[1].replace(/&amp;/g, "&"), origin);
        if (url.origin === origin) found[url.href] = true;
      } catch {
        // Not a URL; skip.
      }
    }
    return Object.keys(found);
  }

  /** The page shown for an offline navigation when nothing is cached for it. */
  function offlineHtml() {
    return (
      "<!doctype html>" +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      "<title>Offline · Bingo Night</title>" +
      '<meta name="theme-color" content="#fbf8ef">' +
      "<style>" +
      ":root{--paper:#fbf8ef;--ink:#2f3337;--ink-soft:#62676c;--margin:#e98b8f}" +
      "@media (prefers-color-scheme:dark){:root{--paper:#33302a;--ink:#ebe6da;--ink-soft:#b7b0a2;--margin:#7f4247}}" +
      "html,body{margin:0;background:var(--paper);color:var(--ink)}" +
      'body{font-family:"Patrick Hand","Comic Sans MS","Chalkboard SE",ui-rounded,system-ui,sans-serif;' +
      "min-height:100vh;padding:max(48px,env(safe-area-inset-top)) 24px 24px 56px;box-sizing:border-box;" +
      "background-image:linear-gradient(to right,transparent 40px,var(--margin) 40px,var(--margin) 42px,transparent 42px)}" +
      "h1{font-size:2rem;line-height:1.2;margin:0 0 12px}" +
      "p{font-size:1.25rem;line-height:1.4;margin:0 0 24px;color:var(--ink-soft);max-width:28rem}" +
      "button{font:inherit;font-size:1.25rem;min-height:44px;padding:8px 20px;color:var(--ink);background:transparent;" +
      "border:2px solid var(--ink);border-radius:255px 18px 225px 18px/18px 225px 18px 255px}" +
      "</style></head><body>" +
      "<h1>Bingo Night</h1>" +
      "<p>You’re offline — the board will load as soon as you have signal.</p>" +
      '<button type="button" onclick="location.reload()">Try again</button>' +
      '<script>addEventListener("online",function(){location.reload()})</script>' +
      "</body></html>"
    );
  }

  scope.BingoSWPolicy = {
    CACHE_VERSION: CACHE_VERSION,
    CACHE_PREFIX: CACHE_PREFIX,
    CACHE_NAMES: CACHE_NAMES,
    CACHE_LIMITS: CACHE_LIMITS,
    NAVIGATION_TIMEOUT_MS: NAVIGATION_TIMEOUT_MS,
    STRATEGY: STRATEGY,
    readConfig: readConfig,
    selectStrategy: selectStrategy,
    shouldCache: shouldCache,
    cacheNameFor: cacheNameFor,
    cacheLimitFor: cacheLimitFor,
    isCacheableResponse: isCacheableResponse,
    pageCacheKey: pageCacheKey,
    staleCacheNames: staleCacheNames,
    extractShellAssetUrls: extractShellAssetUrls,
    offlineHtml: offlineHtml,
  };
})(self);
