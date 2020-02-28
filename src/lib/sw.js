import * as idb from "idb-keyval";
import manifest from "cache-manifest";
import layoutTemplate from "layout-template";
import {initialize as initializeGoogleAnalytics} from "workbox-google-analytics";
import * as workboxRouting from "workbox-routing";
import * as workboxStrategies from "workbox-strategies";
import {CacheableResponsePlugin} from "workbox-cacheable-response";
import {ExpirationPlugin} from "workbox-expiration";
import {matchPrecache, precacheAndRoute} from "workbox-precaching";

// Architecture revision of the Service Worker. If the previously saved revision doesn't match,
// then this will cause clients to be aggressively claimed and reloaded on install/activate.
// Used when the design of the SW changes dramatically, e.g. from DevSite to v2.
const serviceWorkerArchitecture = "v3";

let replacingPreviousServiceWorker = false;

self.addEventListener("install", (event) => {
  // This is non-null if there was a previous Service Worker registered. Record for "activate", so
  // that a lack of current architecture can be seen as a reason to reload our clients.
  if (self.registration.active) {
    replacingPreviousServiceWorker = true;
  }

  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  const p = Promise.resolve().then(async () => {
    const previousArchitecture = await idb.get("arch");
    if (previousArchitecture === undefined && replacingPreviousServiceWorker) {
      // We're replacing a Service Worker that didn't have architecture info. Force reload.
    } else if (
      !replacingPreviousServiceWorker ||
      previousArchitecture === serviceWorkerArchitecture
    ) {
      // The architecture didn't change (or this is a brand new install), don't force a reload,
      // upgrades will happen in due course.
      return;
    }
    console.debug(
      "web.dev SW upgrade from",
      previousArchitecture,
      "to arch",
      serviceWorkerArchitecture,
    );

    await self.clients.claim();

    // Reload all open pages (includeUncontrolled shouldn't be needed as we've _just_ claimed
    // clients, but include it anyway for sanity).
    const windowClients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: "window",
    });

    // It's impossible to 'await' this navigation because this event would literally be blocking
    // our fetch handlers from running. These navigates must be 'fire-and-forget'.
    windowClients.map((client) => client.navigate(client.url));

    await idb.set("arch", serviceWorkerArchitecture);
  });
  event.waitUntil(p);
});

initializeGoogleAnalytics();

// Cache the Google Fonts stylesheets with a stale-while-revalidate strategy.
workboxRouting.registerRoute(
  /^https:\/\/fonts\.googleapis\.com/,
  new workboxStrategies.StaleWhileRevalidate({
    cacheName: "google-fonts-stylesheets",
  }),
);

// Cache the underlying font files with a cache-first strategy for 1 year.
workboxRouting.registerRoute(
  /^https:\/\/fonts\.gstatic\.com/,
  new workboxStrategies.CacheFirst({
    cacheName: "google-fonts-webfonts",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxAgeSeconds: 60 * 60 * 24 * 365,
        maxEntries: 30,
      }),
    ],
  }),
);

// Configure default cache for standard web.dev files: the offline page, various images etc.
precacheAndRoute(manifest);

/**
 * Match "/foo-bar" and "/foo-bar/as-many/but/no/trailing/slash" (but not "/foo/bar/index.html").
 * This only matches on pathname (so it must always start with "/").
 */
const untrailedContentPathRe = new RegExp("^(/[\\w-]+)+$");

/**
 * Match fetches for patials, for SPA requests. Matches "/foo-bar/index.json" and
 * "/foo-bar/many/parts/index.json", for partial SPA requests.
 */
const partialPathRe = new RegExp("^/([\\w-]+/)*index\\.json$");
const partialStrategy = new workboxStrategies.NetworkFirst();
workboxRouting.registerRoute(({url, event}) => {
  return url.host === self.location.host && partialPathRe.test(url.pathname);
}, partialStrategy);

/**
 * Cache images that aren't included in the original manifest, such as author profiles.
 */
workboxRouting.registerRoute(
  new RegExp("/images/.*"),
  new workboxStrategies.StaleWhileRevalidate(),
);

/**
 * Match "/foo-bar/ "and "/foo-bar/as/many/of-these-as-you-like/" (with optional trailing
 * "index.html"), normal page nodes for web.dev. This only matches on pathname.
 *
 * This fetch handler internally fetches the required partial using `partialStrategy`, and
 * generates the page's real HTML based on the layout template.
 */
const contentPathRe = new RegExp("^(/(?:[\\w-]+/)*)(?:|index\\.html)$");
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  const m = contentPathRe.exec(u.pathname);

  if (!m || self.location.host !== u.host) {
    return;
  }

  const url = m[1]; // e.g. "/foo/bar/" or "/"

  const p = Promise.resolve().then(async () => {
    let status = 200;
    let response;
    try {
      // Use the same strategy for partials when hydrating a full request.
      response = await partialStrategy.handle({
        request: new Request(url + "index.json"),
      });
      if (response.status === 404) {
        response = await notFoundPartial();
        status = 404;
      }
    } catch (e) {
      // We serve offline pages with a 200 status, just to be confusing.
      console.warn("serving offline partial for", url, "due to", e);
      response = await offlinePartial();
    }

    if (!response.ok) {
      throw response.status;
    }
    const partial = await response.json();

    // Our target browsers all don't mind if we just place <title> in the middle of the document.
    // This is far simpler than trying to find the right place in <head>.
    const meta = partial.offline ? `<meta name="offline" value="true" />` : "";
    const output = layoutTemplate.replace(
      "%_CONTENT_REPLACE_%",
      meta + `<title>${escape(partial.title)}</title>` + partial.raw,
    );
    const headers = new Headers();
    headers.append("Content-Type", "text/html");
    return new Response(output, {headers, status});
  });

  event.respondWith(p);
});

/**
 * This is a special handler for requests without a trailing "/". These requests _should_ go to
 * the network (so that we can match web.dev's redirects.yaml file) but fallback to the normalized
 * version of the request (e.g., "/foo" => "/foo/").
 */
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  if (
    !untrailedContentPathRe.test(u.pathname) ||
    self.location.host !== u.host
  ) {
    return;
  }

  const p = Promise.resolve().then(async () => {
    // First, check if there's actually something in the cache already. Workbox always suffixes
    // with "/index.html" relative to our actual request paths.
    const cachedResponse = await matchPrecache(u.pathname + "/index.html");
    if (!cachedResponse) {
      // If there's not, then try the network.
      try {
        return await fetch(event.request);
      } catch (e) {
        // If fetch fails, just redirect below.
      }
    }

    // Either way, redirect to the updated Location.
    const headers = new Headers();
    headers.append("Location", event.request.url + "/");
    const redirectResponse = new Response("", {
      status: 301,
      headers,
    });
    return redirectResponse;
  });

  event.respondWith(p);
});

async function notFoundPartial() {
  const cachedResponse = await matchPrecache("/404/index.json");
  if (!cachedResponse) {
    // This occurs in development when the 404 partial isn't precached.
    return new Response(JSON.stringify({raw: "<h1>Dev 404</h1>", title: ""}));
  }
  return cachedResponse;
}

async function offlinePartial() {
  const cachedResponse = await matchPrecache("/offline/index.json");
  if (!cachedResponse) {
    // This occurs in development when the offline partial isn't precached.
    return new Response(
      JSON.stringify({offline: true, raw: "<h1>Dev offline</h1>", title: ""}),
    );
  }
  return cachedResponse;
}

workboxRouting.setCatchHandler(async ({event, url}) => {
  // Our routing config for partial files is done with Workbox, so we have to run the same check
  // here if it failed, and return the offline partial.
  if (url.host === self.location.host && partialPathRe.test(url.pathname)) {
    return offlinePartial();
  }
});
