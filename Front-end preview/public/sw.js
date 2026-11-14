const CACHE = 'liveroom-demo-v12';
const assets = ['/mark.svg','/manifest.webmanifest','/touch.png', ...Array.from({length:8},(_,i)=>'/furniture/'+(i+1)+'.webp'),...Array.from({length:8},(_,i)=>'/models/'+(i+1)+'.usdz'),...Array.from({length:8},(_,i)=>'/models/'+(i+1)+'.json')];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const home = await fetch('/', {cache:'reload'});
  if (!home.ok) throw new Error('App shell unavailable');
  const manifest = await fetch("/offline-assets.json", {cache:"reload"});
  if (!manifest.ok) throw new Error("Offline manifest unavailable");
  const {paths: bundles} = await manifest.json();
  await cache.addAll([...assets,...bundles]);
  await cache.put('/',home);
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(key=>key.startsWith('liveroom-')&&key!==CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if(request.mode==='navigate'){
      try{return await fetch(request);}catch{return (await cache.match('/'))||Response.error();}
    }
    const existing=await cache.match(request);if(existing)return existing;
    const response=await fetch(request);
    if(response.ok&&response.type==='basic'&&!request.headers.has('Range'))await cache.put(request,response.clone());
    return response;
  })());
});
