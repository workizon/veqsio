/*
 * Minimal service worker: makes the app installable and shows an offline page when the network is down.
 * It deliberately caches NOTHING that belongs to a signed-in user: no API responses (/rest, /auth, /scim) and
 * no HTML pages. Only immutable build assets and icons are cached, plus the static offline page.
 */
const VERSION = 'v2'
const STATIC_CACHE = `static-${VERSION}`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll([OFFLINE_URL, '/icons/icon-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('static-') && k !== STATIC_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (/^\/(rest|auth|scim)\//.test(url.pathname)) return // never touch API traffic

  if (req.mode === 'navigate') {
    // Pages always come from the network (they carry user data); offline shows the static page.
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)))
    return
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      }),
    )
  }
})

// Web Push: the payload is { title, body, url, tag } and contains no more than the notification text itself.
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = {} }
  event.waitUntil(self.registration.showNotification(d.title || 'Veqsio', {
    body: d.body || '', tag: d.tag, icon: '/icons/icon-192.png', data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus() } }
    return self.clients.openWindow(url)
  }))
})
