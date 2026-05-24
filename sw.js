const CACHE='eq-pwa-v4';
const STATIC=['./','./index.html','./manifest.json','https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC).catch(()=>{})));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(url.hostname==='api.anthropic.com'||e.request.method==='POST'){e.respondWith(fetch(e.request));return;}
  e.respondWith(caches.match(e.request).then(c=>{
    if(c) return c;
    return fetch(e.request).then(r=>{
      if(r&&r.status===200&&r.type!=='opaque') caches.open(CACHE).then(c=>c.put(e.request,r.clone()));
      return r;
    }).catch(()=>e.request.destination==='document'?caches.match('./index.html'):undefined);
  }));
});
