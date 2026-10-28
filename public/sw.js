// Offline support: once visited, the app shell and the emulator cores load from cache.
const CACHE = 'snes-touch-v1'
const CORE_HOST = 'cdn.jsdelivr.net' // versioned, immutable emulator core files

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/roms/')) return // bundled ROMs are copied into IndexedDB once
  if (url.pathname.startsWith('/gc/')) return // the GameCube emulator fetches its 13 MB core uncached on purpose
  if (request.mode === 'navigate') event.respondWith(networkFirst(request))
  else if (url.hostname === CORE_HOST || (url.origin === location.origin && /^\/(assets|cores)\//.test(url.pathname)))
    event.respondWith(cacheFirst(request))
  else if (url.origin === location.origin) event.respondWith(staleWhileRevalidate(event))
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put('/', response.clone())
    return response
  } catch {
    return (await cache.match('/')) ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(event.request)
  const refresh = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(event.request, response.clone())
    return response
  })
  if (!cached) return refresh
  event.waitUntil(refresh.catch(() => undefined))
  return cached
}
