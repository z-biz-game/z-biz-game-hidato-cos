'use strict';
// Service worker · 智渡 Hidato
//
// 两条口径钉在这里，都是本组织踩过的坑：
//   1. **缓存名带版本号**，activate 时把不是当前版本的桶整批删掉。不留版本号 = 改了代码
//      还住在旧缓存里，玩家永远拿到同一份旧 js。
//   2. **同源子资源一律网络优先，失败才退缓存**。反例是 cache-first + 手工 VERSION 号：
//      版本号忘了 bump 就把 js/css 永久钉死在旧版，出新 HTML 配旧 JS 的鬼状态比断网更难受。
//      网络优先的代价是首字节慢一点，换来的是"线上是什么就是什么"。
//   3. 导航请求（打开页面本身）在离线时回落到缓存里的 index.html —— 盘是 seed 的纯函数，
//      引擎全在本地，所以离线打开是**真能玩**的，不是给玩家看一张离线空壳。
const VERSION = 'hidato-v1';
const SHELL = ['index.html', 'css/game.css', 'js/main.js', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;      // 第三方一律不接管
  ev.respondWith(
    fetch(req).then((res) => {
      // 只有 200 才回填：把 404/500 存进桶里，等于把一次网络抖钉成永久故障。
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit
      || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
