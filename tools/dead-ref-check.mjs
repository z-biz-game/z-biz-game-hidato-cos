// 死引用自检 · 把一份"站点目录"当成已经部署的页面读一遍
//
// 为什么需要它：本仓无构建 = 文件拷贝，于是"页面引用了一个没进工件的路径"这类错**不会**让任何
// 一道行为闸变红 —— 它变成玩家手机上"能打开但装不上 / 没底纹 / 图标是空白"。CI 全绿与线上是坏的
// 可以同时成立，中间只隔着这条脚本。
//
// 真实读数（本机 2026-10-02）：在 `pages.yml` 的拷贝清单补上 `assets/img/` 之前，拿旧清单装的工件
// 跑它 → `MISS css/game.css → ../assets/img/paper-256.png` + `MISS manifest.webmanifest →
// assets/img/icons/icon-1024.png`，本地引用 13 条缺 2 条，exit 1；补全后同一台机器 13/0，exit 0。
//
// 用法：node tools/dead-ref-check.mjs <站点目录>      （仓根 "./" 查源码，"_site" 查部署工件）
// 查三处引用来源，都按部署后的相对位置解析（不是按仓根）：
//   1. index.html 的每个 src/href；
//   2. css/*.css 里每个 url()（相对**该 css 自己**的位置，所以 ../assets/... 是对的）；
//   3. manifest.webmanifest 的 icons[].src 与 screenshots[].src（相对 manifest 的位置）。
// 只核"文件在不在"，不核内容 —— 内容对不对由 ci.yml 里那条读 PNG IHDR 的步骤负责（签名 + 边长）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
// 绝对 URL、data:、#锚点、协议相对 "//" 都不是本站文件，跳过。
// og:image 是例外里的例外：爬虫不会拿相对路径去拼本站之外的落地页，所以那种写法本身就是错 —— 见下。
const EXTERNAL = /^(https?:|data:|mailto:|#|\/\/)/;

/** @returns {Array<[string, string]>} [引用它的那个文件, 原始引用串] */
function collectRefs(root) {
  const refs = [];
  const htmlPath = path.join(root, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) refs.push(['index.html', m[1]]);
  for (const line of html.split('\n')) {
    // 精确到收尾引号：`og:image:width` 的 content="1200" 是尺寸不是引用，算进来就是一条必然红的门。
    if (!/="og:image"|"twitter:image"/.test(line)) continue;
    const m = line.match(/content="([^"]+)"/);
    if (m && !EXTERNAL.test(m[1])) refs.push(['index.html(og) ' + m[1], m[1]]);
  }
  for (const f of fs.readdirSync(path.join(root, 'css')).filter((x) => x.endsWith('.css'))) {
    const t = fs.readFileSync(path.join(root, 'css', f), 'utf8');
    for (const m of t.matchAll(/url\(["']?([^"')]+)["']?\)/g)) refs.push(['css/' + f, m[1]]);
  }
  const mfPath = path.join(root, 'manifest.webmanifest');
  if (fs.existsSync(mfPath)) {
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    for (const ic of mf.icons || []) refs.push(['manifest.webmanifest', ic.src]);
    for (const sc of mf.screenshots || []) refs.push(['manifest.webmanifest', sc.src]);
  }
  return refs;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error(`dead-ref：${ROOT} 里没有 index.html —— 这不是站点目录`);
    process.exit(2);
  }
  const refs = collectRefs(ROOT);
  let checked = 0, missing = 0, absoluteSiteRef = 0;
  for (const [from, raw] of refs) {
    const clean = raw.replace(/[?#].*$/, '');
    if (EXTERNAL.test(clean)) continue;
    // manifest 里 "/icons/x.png" 在根域部署下没事，在项目 Pages（/仓库名/）下必然 404：
    // 本站的落地位置就是带子路径的，所以绝对路径引用直接算错，不等线上验。
    if (clean.startsWith('/') && from !== 'index.html(og)') {
      absoluteSiteRef++;
      console.log(`ABS  ${from} → ${raw}（绝对路径，在项目 Pages 子路径下会 404）`);
      continue;
    }
    const target = path.resolve(ROOT, path.dirname(from.startsWith('index.html') ? 'index.html' : from), clean);
    checked++;
    if (!fs.existsSync(target)) {
      missing++;
      console.log(`MISS ${from} → ${raw}`);
    }
  }
  const bad = missing + absoluteSiteRef;
  console.log(`本地引用 ${checked} 条，缺文件 ${missing} 条，绝对路径引用 ${absoluteSiteRef} 条 → ${bad ? 'RED' : 'ok'}`);
  process.exit(bad ? 1 : 0);
}

main();
