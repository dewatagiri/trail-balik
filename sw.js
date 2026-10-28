/* Trail Balik service worker: keeps the app working with no signal.
   - App files are cached on install (bump SHELL when any of them change).
   - Map files (.pmtiles) are only stored when you tap Download in More.
     Saved maps are answered from the cache, including the Range requests
     the map makes for each tile. */
"use strict";
var SHELL = "tb-shell-v2", MAPS = "tb-maps", FONTS = "tb-fonts";
var FILES = [
  "./", "index.html",
  "vendor/maplibre-gl.js", "vendor/maplibre-gl.css", "vendor/pmtiles.js", "vendor/protomaps-basemaps.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
  "sprites/light.json", "sprites/light.png", "sprites/light@2x.json", "sprites/light@2x.png"
];
["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"].forEach(function(f){
  ["0-255", "256-511", "512-767", "8192-8447", "8448-8703"].forEach(function(r){ FILES.push("glyphs/" + f + "/" + r + ".pbf"); });
});

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(SHELL).then(function(c){ return c.addAll(FILES); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf("tb-shell-") === 0 && k !== SHELL; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

/* Saved map files, kept as Blobs in memory so each tile read is a cheap slice. */
var blobs = {};
function mapBlob(url){
  if(blobs[url]) return Promise.resolve(blobs[url]);
  return caches.open(MAPS).then(function(c){ return c.match(url); }).then(function(r){
    if(!r) return null;
    return r.blob().then(function(b){ blobs[url] = b; return b; });
  });
}

function rangeReply(blob, range){
  var size = blob.size, m = /bytes=(\d*)-(\d*)/.exec(range || "");
  if(!m) return new Response(blob, {status:200, headers:{"Content-Type":"application/octet-stream", "Content-Length":String(size)}});
  var a, b;
  if(m[1] === ""){ a = Math.max(0, size - Number(m[2])); b = size - 1; }      // bytes=-N (last N bytes)
  else { a = Number(m[1]); b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if(a >= size || a > b) return new Response(null, {status:416, headers:{"Content-Range":"bytes */" + size}});
  return new Response(blob.slice(a, b + 1), {status:206, headers:{
    "Content-Type":"application/octet-stream", "Content-Length":String(b - a + 1), "Content-Range":"bytes " + a + "-" + b + "/" + size
  }});
}

self.addEventListener("message", function(e){
  // The page tells us when a map is saved or deleted, so the in-memory copy stays right.
  if(e.data && e.data.type === "maps-changed") blobs = {};
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);

  // Google Fonts: use the saved copy if there is one, refresh it when online.
  if(url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com"){
    e.respondWith(caches.open(FONTS).then(function(c){
      return c.match(req).then(function(hit){
        var net = fetch(req).then(function(r){ if(r.ok || r.type === "opaque") c.put(req, r.clone()); return r; });
        return hit || net;
      });
    }));
    return;
  }
  if(url.origin !== location.origin) return;

  // Map files: answer from a saved download, otherwise go to the network as before.
  if(/\.pmtiles$/.test(url.pathname)){
    var key = url.origin + url.pathname;
    e.respondWith(mapBlob(key).then(function(b){
      return b ? rangeReply(b, req.headers.get("range")) : fetch(req);
    }));
    return;
  }

  // The page itself: try the network first so updates arrive, fall back to the saved copy.
  if(req.mode === "navigate"){
    e.respondWith(fetch(req).then(function(r){
      if(r.ok){ var copy = r.clone(); caches.open(SHELL).then(function(c){ c.put("index.html", copy); }); }
      return r;
    }).catch(function(){
      return caches.match("index.html", {cacheName:SHELL, ignoreSearch:true});
    }));
    return;
  }

  // Everything else from this site: saved copy first, then the network.
  e.respondWith(caches.match(req, {ignoreSearch:true}).then(function(hit){ return hit || fetch(req); }));
});
