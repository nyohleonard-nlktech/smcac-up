/* ============================================================
   SMCAC ACADEMY — SERVICE WORKER
   Two caches, two different strategies, on purpose:

   1. APP_SHELL_CACHE — cache-first. The pages/CSS themselves
      rarely change and contain no permissioned data, so serve
      instantly from cache and only hit the network as a fallback.

   2. MODULE_CACHE — network-first. Every module PDF request
      MUST go through Supabase's live RLS check when a connection
      exists, because that check is what enforces payment status
      and the 90-day expiry. The cache is only a fallback for when
      there is truly no network — and if a live check ever comes
      back denied (revoked/expired), any previously cached copy
      for that exact file is deleted immediately, so it can't be
      opened offline afterward either. See the discussion this was
      built from: offline access to a still-cached file is a real,
      accepted limitation for someone who never reconnects, not a
      bug — this is the deliberate middle ground, not a full fix.
   ============================================================ */

const SHELL_CACHE = 'smcac-shell-v3';
const MODULE_CACHE = 'smcac-modules-v1';

const APP_SHELL_FILES = [
  'index.html',
  'docs.html',
  'registration.html',
  'company-registration.html',
  'individual-dashboard.html',
  'company-dashboard.html',
  'super-admin.html',
  'admin-content.html',
  'module-viewer.html',
  'verify.html',
  'style.css',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .catch((err) => console.warn('SMCAC SW: shell cache pre-fill failed for one or more files', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== MODULE_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isModuleFileRequest(url) {
  return url.includes('/storage/v1/object/') && url.includes('/modules/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  if (request.method !== 'GET') return; // never intercept writes/RPCs

  if (isModuleFileRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cache = caches.open(MODULE_CACHE);
          if (response.ok) {
            const clone = response.clone();
            cache.then((c) => c.put(request, clone));
          } else {
            // Live check said no (locked/expired) — remove any stale
            // cached copy so offline mode can't serve it either.
            cache.then((c) => c.delete(request));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) =>
            cached || new Response('', { status: 503, statusText: 'Hors ligne et non mis en cache' })
          )
        )
    );
    return;
  }

  // HTML navigation — network-first so a new deployment is shown immediately.
  // If offline, fall back to the cached shell.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) =>
          cached || new Response('Offline', { status: 503, statusText: 'Offline' })
        ))
    );
    return;
  }

  // Other app-shell assets — cache-first for fast loading.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
