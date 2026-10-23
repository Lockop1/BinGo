/*
 * Bingo Night service worker (hand-written, no bundler).
 *
 * Caches the app shell so the site opens instantly on bad signal:
 * - page navigations: network first, cached copy after 3 s or when offline,
 *   a tiny inline offline page when nothing is cached;
 * - /_next/static (content-hashed): cache first;
 * - icons, fonts, manifest: stale-while-revalidate.
 * Everything else, in particular Supabase (auth / REST / Realtime / Storage /
 * signed media URLs), /api routes, RSC data requests and non-GET requests, is
 * left to the network untouched and is never cached. The rules live in
 * /sw-policy.js (pure, unit-tested).
 *
 * Registered by src/components/pwa/ServiceWorkerRegistration.tsx as
 * /sw.js?supabase=<origin>[&dev=1].
 */
importScripts("/sw-policy.js");

var P = self.BingoSWPolicy;
var CONFIG = P.readConfig(self.location.href);

function offlineResponse() {
  return new Response(P.offlineHtml(), {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// waitUntil() throws once the event has finished; a late cache write is simply skipped then.
function extendLifetime(event, promise) {
  var guarded = Promise.resolve(promise).catch(function () {});
  try {
    event.waitUntil(guarded);
  } catch {
    // Event already settled; the promise still runs while the worker is alive.
  }
  return guarded;
}

function trimCache(cacheName) {
  var limit = P.cacheLimitFor(cacheName);
  if (!limit) return Promise.resolve();
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      // keys() lists entries in insertion order: drop the oldest beyond the limit.
      var excess = keys.slice(0, Math.max(0, keys.length - limit));
      return Promise.all(
        excess.map(function (key) {
          return cache.delete(key);
        }),
      );
    });
  });
}

function putInCache(cacheName, key, response) {
  return caches
    .open(cacheName)
    .then(function (cache) {
      return cache.put(key, response);
    })
    .then(function () {
      return trimCache(cacheName);
    })
    .catch(function () {
      // Quota or storage errors must never break a request.
    });
}

// Fetches a same-origin asset URL into its cache if the policy allows it and it is missing.
function warmAsset(rawUrl) {
  var request;
  try {
    request = new Request(rawUrl, { credentials: "same-origin" });
  } catch {
    return Promise.resolve();
  }
  var strategy = P.selectStrategy(request, CONFIG);
  if (!strategy || strategy === P.STRATEGY.navigation) return Promise.resolve();
  var cacheName = P.cacheNameFor(strategy);
  return caches
    .open(cacheName)
    .then(function (cache) {
      return cache.match(request, { ignoreVary: true }).then(function (hit) {
        if (hit) return undefined;
        return fetch(request).then(function (response) {
          if (P.isCacheableResponse(response, strategy)) return putInCache(cacheName, request, response);
          return undefined;
        });
      });
    })
    .catch(function () {});
}

// Fetches a page's HTML into the pages cache (if missing, or always when `refresh`).
function warmPage(rawUrl, refresh) {
  var key;
  try {
    key = P.pageCacheKey(rawUrl);
  } catch {
    return Promise.resolve(null);
  }
  var probe = { url: key, method: "GET", mode: "navigate", headers: new Headers() };
  if (P.selectStrategy(probe, CONFIG) !== P.STRATEGY.navigation) return Promise.resolve(null);
  return caches
    .open(P.CACHE_NAMES.pages)
    .then(function (cache) {
      return (refresh ? Promise.resolve(undefined) : cache.match(key, { ignoreVary: true })).then(function (hit) {
        if (hit) return null;
        return fetch(new Request(key, { credentials: "same-origin", cache: "reload" })).then(function (response) {
          if (!P.isCacheableResponse(response, P.STRATEGY.navigation)) return null;
          return response
            .clone()
            .text()
            .then(function (html) {
              return putInCache(P.CACHE_NAMES.pages, key, response).then(function () {
                return html;
              });
            });
        });
      });
    })
    .catch(function () {
      return null;
    });
}

self.addEventListener("install", function (event) {
  // Take over on the next load instead of waiting for every tab to close.
  self.skipWaiting();
  // Best effort: warm "/" and the build assets its HTML references. Installing never
  // fails because of a bad connection; runtime caching fills in the rest.
  event.waitUntil(
    warmPage(CONFIG.origin + "/", true)
      .then(function (html) {
        if (!html) return undefined;
        return Promise.all(P.extractShellAssetUrls(html, CONFIG.origin).map(warmAsset));
      })
      .catch(function () {}),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    Promise.resolve()
      .then(function () {
        if (self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable().catch(function () {});
        }
        return undefined;
      })
      .then(function () {
        return caches.keys();
      })
      .then(function (names) {
        return Promise.all(
          P.staleCacheNames(names).map(function (name) {
            return caches.delete(name);
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function preloadOrFetch(event) {
  return Promise.resolve(event.preloadResponse)
    .catch(function () {
      return undefined;
    })
    .then(function (preloaded) {
      return preloaded || fetch(event.request);
    });
}

function matchPage(request) {
  return caches.open(P.CACHE_NAMES.pages).then(function (cache) {
    var key = P.pageCacheKey(request.url);
    return cache.match(key, { ignoreVary: true }).then(function (hit) {
      return hit || cache.match(key, { ignoreVary: true, ignoreSearch: true });
    });
  });
}

function handleNavigation(event) {
  var request = event.request;
  // The network request runs to completion even when the cached copy wins the race,
  // so the next open is fresh.
  var network = preloadOrFetch(event).then(function (response) {
    if (P.isCacheableResponse(response, P.STRATEGY.navigation)) {
      return putInCache(P.CACHE_NAMES.pages, P.pageCacheKey(request.url), response.clone()).then(function () {
        return response;
      });
    }
    return response;
  });
  extendLifetime(event, network);

  var timedOut = new Promise(function (resolve) {
    setTimeout(function () {
      resolve("timeout");
    }, P.NAVIGATION_TIMEOUT_MS);
  });
  var settled = network.then(
    function (response) {
      return { response: response };
    },
    function () {
      return "failed";
    },
  );

  return Promise.race([settled, timedOut]).then(function (outcome) {
    if (outcome !== "timeout" && outcome !== "failed") return outcome.response;
    return matchPage(request)
      .catch(function () {
        return undefined;
      })
      .then(function (cached) {
        if (cached) return cached;
        // Slow but not dead: keep waiting for the network. Dead: the offline page.
        if (outcome === "timeout") {
          return network.catch(function () {
            return offlineResponse();
          });
        }
        return offlineResponse();
      });
  });
}

function handleCacheFirst(event, cacheName, strategy) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(event.request, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(event.request).then(function (response) {
        if (P.isCacheableResponse(response, strategy)) {
          extendLifetime(event, putInCache(cacheName, event.request, response.clone()));
        }
        return response;
      });
    });
  });
}

function handleNetworkFirst(event, cacheName, strategy) {
  return fetch(event.request).then(
    function (response) {
      if (P.isCacheableResponse(response, strategy)) {
        extendLifetime(event, putInCache(cacheName, event.request, response.clone()));
      }
      return response;
    },
    function (error) {
      return caches.match(event.request, { cacheName: cacheName, ignoreVary: true }).then(function (hit) {
        if (hit) return hit;
        throw error;
      });
    },
  );
}

function handleStaleWhileRevalidate(event, cacheName, strategy) {
  var update = fetch(event.request).then(function (response) {
    if (P.isCacheableResponse(response, strategy)) {
      return putInCache(cacheName, event.request, response.clone()).then(function () {
        return response;
      });
    }
    return response;
  });
  extendLifetime(event, update);
  return caches.match(event.request, { cacheName: cacheName, ignoreVary: true }).then(function (hit) {
    return hit || update;
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var strategy = P.selectStrategy(request, CONFIG);

  if (!strategy) {
    // Not ours: plain network, never cached. A bypassed navigation still uses the
    // preload response (if one was started) so it is not fetched twice.
    if (request.mode === "navigate" && event.preloadResponse) {
      event.respondWith(preloadOrFetch(event));
    }
    return;
  }

  var cacheName = P.cacheNameFor(strategy);
  if (strategy === P.STRATEGY.navigation) {
    event.respondWith(handleNavigation(event));
  } else if (strategy === P.STRATEGY.cacheFirst) {
    event.respondWith(handleCacheFirst(event, cacheName, strategy));
  } else if (strategy === P.STRATEGY.networkFirst) {
    event.respondWith(handleNetworkFirst(event, cacheName, strategy));
  } else if (strategy === P.STRATEGY.staleWhileRevalidate) {
    event.respondWith(handleStaleWhileRevalidate(event, cacheName, strategy));
  }
});

self.addEventListener("message", function (event) {
  var data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "WARM") {
    // The page lists what it loaded before this worker controlled it, so the shell
    // works offline from the very first visit. Every URL still goes through the policy.
    var pages = Array.isArray(data.pages) ? data.pages.slice(0, 5) : [];
    var assets = Array.isArray(data.assets) ? data.assets.slice(0, 200) : [];
    event.waitUntil(
      Promise.all(
        pages
          .filter(function (url) {
            return typeof url === "string";
          })
          .map(function (url) {
            return warmPage(url, false);
          })
          .concat(
            assets
              .filter(function (url) {
                return typeof url === "string";
              })
              .map(warmAsset),
          ),
      ).catch(function () {}),
    );
  }
});
