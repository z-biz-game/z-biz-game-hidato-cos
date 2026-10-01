'use strict';
// PWA 注册腿（经典脚本，不是 module：它要在 ES module 之前/之后都能跑起来）
//
// file:// 下整段跳过并且**不抛未捕获异常**：直接双击 index.html 打开是本仓的用法之一
// （tools/verify.sh 之外，人也是这么看货的）。file:// 没有 SW 的注册语义，navigator
// .serviceWorker 在那儿要么不存在要么 register 必抛 —— 那不是玩家的错，不该在控制台留一条红。
// 同理旧 Safari / 无痕窗口拿不到 serviceWorker，一律静默。
(function () {
  if (!('serviceWorker' in navigator)) return;
  var proto = location.protocol;
  if (proto !== 'http:' && proto !== 'https:') return;
  // 按 document.baseURI 解析，不写死 'sw.js'：本仓有两种 URL 形态（仓库=文档根的 root 形态，
  // 和 Pages 的 /<repo>/ 前缀形态）。相对字面量在前缀形态下会解到站点根，注册到别人那口上。
  var url = new URL('sw.js', document.baseURI).href;
  var go = function () {
    try {
      navigator.serviceWorker.register(url).catch(function () { /* 注册失败：继续在线玩 */ });
    } catch (e) { /* 老浏览器连 register 都能抛同步异常，同样不算玩家的错 */ }
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
})();
