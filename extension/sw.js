// Net Tracer service worker: offline cache for the web app and Android "share to" target for PDFs.
const VERSION = 'nt-v0.7.0';
const ASSETS = ['./', './index.html', './js/viewer.js', './js/i18n.js', './js/analyze.worker.js', './js/core/geom.js', './js/core/extract.js', './js/core/nets.js', './js/core/model.js', './js/core/search.js', './js/core/export.js', './js/core/pipeline.js', './lib/pdf.min.mjs', './lib/pdf.worker.min.mjs', './lib/jspdf.umd.min.js', './lib/demo.js', './manifest.webmanifest', './icons/icon48.png', './icons/icon192.png', './icons/icon512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'nt-shared').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await e.request.formData(); const f = fd.get('pdf') || [...fd.values()].find(v => v instanceof File);
      if (f) { const c = await caches.open('nt-shared'); await c.put('shared-pdf', new Response(await f.arrayBuffer(), { headers: { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(f.name || 'shared.pdf') } })); }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const fetching = fetch(e.request).then(res => { if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; }).catch(() => hit);
    return hit || fetching;
  }));
});
