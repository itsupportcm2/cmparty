const CACHE_NAME = 'cm-party-offline-v2';

const PRECACHE_URLS = [
  '/stage.html',
  '/reward.html',
  '/styles.css',
  '/config.js',
  '/logo/logoparty.png',
  '/assets/party-logo.jpg',
  '/assets/sender-elf.png',
  '/assets/sender-santa.png',
  '/assets/sender-photo.png',
  '/assets/bgm-christmas-1.mp3',
  '/assets/bgm-christmas-2.mp3',
  '/assets/sfx-cheer.mp3',
  '/assets/sfx-cheer-applause.mp3',
  '/assets/sfx-applause.wav',
  '/assets/sfx-fireworks.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      PRECACHE_URLS.map((url) =>
        fetch(url, { cache: 'no-cache' })
          .then((res) => {
            if (res && res.ok) return cache.put(url, res);
          })
          .catch(() => {})
      )
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('cm-party-offline-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

async function networkFirstWithTimeout(request, timeoutMs = 3000) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    clearTimeout(timer);
    const urlObj = new URL(request.url);
    const cached = (await cache.match(request, { ignoreSearch: true })) || (await cache.match(urlObj.pathname));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const urlObj = new URL(request.url);
  const cached = (await cache.match(request, { ignoreSearch: true })) || (await cache.match(urlObj.pathname));
  if (cached) return cached;

  const res = await fetch(request);
  if (res && res.ok) {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const pathname = url.pathname;

  if (pathname.startsWith('/assets/') || pathname.startsWith('/logo/')) {
    event.respondWith(cacheFirstAsset(request));
    return;
  }

  const isAppShell =
    pathname === '/' ||
    pathname === '/stage.html' ||
    pathname === '/reward.html' ||
    pathname === '/index.html' ||
    pathname === '/gallery.html' ||
    pathname === '/styles.css' ||
    pathname === '/config.js';

  if (isAppShell) {
    event.respondWith(networkFirstWithTimeout(request, 3000));
  }
});
