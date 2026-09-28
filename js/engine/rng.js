// 随机数 · 本仓唯一入口（FNV-1a 压 seed → splitmix32）
//
// 全仓只有这一个 PRNG，只吃字符串。任何"看上去更随机"的写法（Math.random / Date.now /
// new Date / getRandomValues / loadavg / Object 遍历序）一律不许出现在判定路径上：门禁要在
// 三台机器上得到同一批盘，浏览器和 node 也要给同一张，否则出题器回填进 TIERS 的分位表就是
// 一张不能对账的读数。默认 seed 也不许由日期派生 —— 那等于每天换一批盘。
//
// seed 串形状：`hidato|<size>|<seed>`（生产），选型屏那 120 张测量盘是
// `screen|<size>|<i>`（_tmp-hidato-screen.mjs，2026-09-28，loadavg 5.99→6.37）。
// 档位写在串里，所以换档不会把另一档的盘重新洗牌。produceBoard() 吃的是**整串**，
// 不自己拼前缀 —— 这是 port-check 能拿屏上那 120 个串逐字节复现指纹的前提。
//
// 算法逐行照抄选型屏（连 0x6d2b79f5 这个增量和三段 finalizer 都没动）：换成 zebra 仓那种
// murmur 尾数的 splitmix 会变一批盘，指纹对不上，"端口是否忠实"就无从判定。
//
// 洗牌必须一次性把随机数抽完，比较器里一个都不许抽：node 与 Chrome 的 Array#sort 对相等
// 元素的次序不同（V8 长数组走 TimSort、短的用插入排序），比较器吃随机数会让两边挑出不同的盘。
// 本仓唯一带排序的抽样是 generate 的路径采样（Warnsdorff 前向度），它的随机键在 sort **之前**
// 就抽成数据（见 generate.js 的 samplePathBiased），比较器是纯函数。

/** 32 位 FNV-1a：把任意长度的 seed 串压成一个 32 位起点。偏移量/质数与屏一致，不可改。 */
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 返回一个**裸函数** rnd()（屏的形状）：调用点消费顺序就是屏的消费顺序，
 * 多包一层 {next,int,pick} 对象不会改变数值流，但会让人怀疑"少抽了一次"。
 * 需要 int/pick 的调用方自己写 `(rnd() * k) | 0`，与屏同形。
 */
export function makeRng(seedStr) {
  let a = hash32(String(seedStr));
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates（原地交换版）：抽样的次数只取决于长度，与元素值/比较无关，
 * 所以换机器、换 sort 实现都得到同一个序。删线索的次序就靠它钉住。
 */
export function shuffled(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/** 生产 seed 串：档位在前、局号在后，局号允许是任意字符串（UI 用递增整数）。 */
export function seedOf(sizeKey, seed) {
  if (!/^[0-9]+x[0-9]+$/.test(String(sizeKey))) throw new Error(`size 标识不合规范：${sizeKey}`);
  return `hidato|${sizeKey}|${seed}`;
}
