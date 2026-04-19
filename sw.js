// sw.js — studyFlow Service Worker v6
// Bump the cache name any time you want to force a full refresh.
const CACHE = 'studyflow-v13';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  'https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700&display=swap'
];

// ── INSTALL ───────────────────────────────────────────────────
// Listen for SKIP_WAITING message from app (auto-update flow)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', event => {
  // Do NOT auto-skipWaiting — the app controls when to activate
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Pre-cache skipped:', url, err.message)
          )
        )
      )
    )
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE).map(k => {
            console.log('[SW] Purging old cache:', k);
            return caches.delete(k);
          })
        )
      )
      .then(() => self.clients.claim()) // Take control of all open pages
  );
});

// ── FETCH ─────────────────────────────────────────────────────
// This listener is REQUIRED for PWA installability.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache: Supabase, Groq, or any /api/* call
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('groq.com') ||
    url.pathname.startsWith('/api/')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Google Fonts → stale-while-revalidate
  if (
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('fonts.googleapis.com')
  ) {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then(res => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Navigation requests (HTML pages) → network-first so updates are instant
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE).then(cache => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(request).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // Static assets → cache-first with network fallback
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          if (
            response &&
            response.status === 200 &&
            (response.type === 'basic' || response.type === 'cors')
          ) {
            caches.open(CACHE).then(cache =>
              cache.put(request, response.clone())
            );
          }
          return response;
        })
        .catch(() => undefined);
    })
  );
});
