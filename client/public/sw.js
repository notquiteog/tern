// Tern service worker: makes the app installable and lets the shell open
// offline. Mail data is never cached here (every /api request goes to the
// network); only the static shell, fonts, icons and the hashed bundles are.
const VERSION = 'v1';
const SHELL = `tern-shell-${VERSION}`;
const ASSETS = `tern-assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(['/', '/favicon.svg', '/theme-init.js', '/manifest.webmanifest']).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tern-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache mail, settings or the unsubscribe pages.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/u/') || url.pathname.startsWith('/bimi/')) return;

  // Pages: network first, the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone())); return res; })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // Hashed bundles and fonts never change under the same name: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(caches.open(ASSETS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  // Icons, logo, manifest, theme-init: serve what we have, refresh in the background.
  event.respondWith(caches.open(SHELL).then(async (c) => {
    const cached = await c.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});

self.addEventListener('message', (event) => { if (event.data === 'skipWaiting') self.skipWaiting(); });

// ---- Web Push: new mail ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'New mail' }; }
  const title = data.title || 'New mail';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'mail',
    renotify: true,
    data: { url: data.url || '/mail/inbox' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/mail/inbox', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => 'focus' in c);
    if (open) { open.navigate(url); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
