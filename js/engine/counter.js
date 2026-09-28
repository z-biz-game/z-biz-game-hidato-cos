// 唯一解裁判 · 传播引导的穷举计数器（允许搜索的那条通道）
//
// Hidato 的解集是"王式图里的一条哈密顿路径"：5×5 的朴素上界是 25! ≈ 1.55e25，任何"枚举全部
// 填法"的读法都不成立，唯一性只能靠线索把树剪掉。剪法（这就是 Test 2 要定价的那件东西）：
//   1) 线索把**值轴**切成若干段连续未印区间（gap）；每个 gap 当成"从锚点出发的定长自避王步走法"
//      枚举，锚点就是 gap 两端那个已印的数所在的格；
//   2) MRV 选 gap：按"可容纳格数（corridor volume）"升序，同体积先短的、再比首步选择数、再比 lo；
//   3) 只允许的三种剪枝：(i) 候选格到远端锚点的切比雪夫距离 ≤ 剩余步数，(ii) corridor 体积 ≥
//      gap 长度（不足即不可行），(iii) 两锚点间距离 ≤ 总步数。
// limitSolutions=2 是"证明唯一"的正确用法：数到第 2 个解立刻收工，1 个解 + 树已穷尽 = 唯一。
//
// 三态出口，**这一个字段就是本仓最要紧的口径**：
//   outcome='unique'    数完恰好 1 个 —— 唯一性被证明
//   outcome='multiple'  数到第 2 个 —— 盘不唯一，确定事实
//   outcome='none'      数完 0 个 —— 题面自相矛盾（出题器 bug 才会走到这里）
//   outcome='stopped'   预算击穿 —— **唯一性未证明**，调用方必须当失败处理
// 半路的 count 也可能是 1，但"还没数完"和"数出来是 1"是两件事，所以 provesUnique() 显式排除
// stopped，而 count 字段永远不许单独被读成"唯一"。
//
// 击穿在出货路径上不是预期事件：屏上最终裁判 40/40 盘、三档全 0 次击穿（25 万节点 / 200 ms，
// 2026-09-28，loadavg 5.99→6.37，p95 0.12/1.05/2.73 ms、max 4.76 ms）。挖线索的探针是另一个
// 预算（4 万节点 / 60 ms），那里击穿是**量到**的：0/1265、30/1862、151/2542 次（5/6/7 档）。
// 探针击穿的后果是"这条线索不许删"，方向安全（只会把盘留得更密），所以它不会污染答案；
// 出题器把这类线索单独记一笔 keptByBudget，就是因为"因多解而留"与"因来不及证伪而留"是两件事。
//
// 时间与节点两个闸都在**每次进节点**时查，ms 闸每 256 个节点查一次：performance.now() 比节点
// 计数贵得多，每节点取一次钟会把裁判本身变成被测成本。这也意味着 ms 闸的粒度是 256 个节点 ——
// 同一台机器上重跑一次，击穿时刻可能有细微差别，所以 ms 预算的设计目标是**永不触发**
// （见 generate.js 的 TIERS 定价），让"同一个 seed 同一张盘"在算术上成立。

import { givenConflict } from './rules.js';

/** 出货裁判的默认预算（屏的 CFG.nodeCap / CFG.budgetMs，2026-09-28 定价依据见 TIERS）。 */
export const REFEREE_BUDGET = Object.freeze({ nodeCap: 250000, msCap: 200 });

/** 唯一性的**唯一**读法。stopped 走不到这里为真。 */
export function provesUnique(r) {
  return r !== null && r !== undefined && r.outcome === 'unique';
}

/**
 * @param G         rules.js 的 buildGrid 产物
 * @param givenCell Int32Array(N+1)，值→格，-1=未印
 * @param opts      {limitSolutions=2, nodeCap=250000, msCap=200}
 * @returns {outcome,count,nodes,ms,stopped,solutions,multiWay,deadEnds,maxGap,zeroBranch,reason?}
 *   multiWay = 出现过 ≥2 个分支的节点数，deadEnds = 走进死路的节点数，
 *   zeroBranch = outcome==='unique' 且两者皆 0 ⇒ "这盘是线索把树剪成一条链"的证人。
 *   stoppedBy = 'nodes' | 'ms' | null —— 击穿是被**哪个闸**掐的。这个字段不是记账，是确定性证人：
 *   'nodes' 掐的击穿只让盘更密（纯函数，同 seed 同盘）；'ms' 掐的会让**同一串在慢机器上出另一张盘**。
 *   所以 balance 的红线断"生产路径 ms 闸从未掐断任何调用"，而不是只在注释里说它不触发。
 *   屏上量到 zeroBranch 0/40（三档都是 0，2026-09-28）—— 门槛是**有选择性的**：裁判要分支，
 *   而命名规则铅笔推不完（BASIC 完成 3/3/2 张），两侧都不是恒真，这个不对称就是产品地基。
 */
export function countSolutions(G, givenCell, opts = {}) {
  const { n, NB, DIST, dist } = G;
  const limit = opts.limitSolutions || 2;
  const nodeCap = opts.nodeCap ?? REFEREE_BUDGET.nodeCap;
  const msCap = opts.msCap ?? REFEREE_BUDGET.msCap;
  const t0 = performance.now();

  const conflict = givenConflict(G, givenCell);
  if (conflict) return { outcome: 'none', reason: conflict, count: 0, nodes: 0, ms: 0, stopped: false, stoppedBy: null, solutions: [], maxGap: 0 };

  const cellOf = new Int32Array(n + 1).fill(-1);
  const used = new Uint8Array(n);
  for (let v = 1; v <= n; v++) { const c = givenCell[v]; if (c >= 0) { cellOf[v] = c; used[c] = 1; } }

  let nodes = 0, multiWay = 0, deadEnds = 0, stopped = false, stoppedBy = null, maxGapLen = 0;
  const sols = [];

  function firstOpts(S0, F0, len0) {
    const l = NB[S0]; const L0 = len0 + 1; let k = 0;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (used[c]) continue;
      if (F0 >= 0 && DIST[c * n + F0] > L0 - 1) continue;
      k++;
    }
    return k;
  }
  function freeNbrs(S0) { const l = NB[S0]; let k = 0; for (let i = 0; i < l.length; i++) if (!used[l[i]]) k++; return k; }
  function countFree() { let k = 0; for (let c = 0; c < n; c++) if (!used[c]) k++; return k; }

  // 返回：gap 描述子（新对象）| false = 没有 gap 了（= 找到一个解）| null = 不可行
  function pickGap() {
    let found = false, bVol = 0, bLen = 0, bOpts = 0, bLo = 0, bLoAnc = -1, bHiAnc = -1;
    let v = 1;
    while (v <= n) {
      if (cellOf[v] !== -1) { v++; continue; }
      let lo = v, hi = v;
      while (hi + 1 <= n && cellOf[hi + 1] === -1) hi++;
      const len = hi - lo + 1;
      const loAnc = lo > 1 ? cellOf[lo - 1] : -1;
      const hiAnc = hi < n ? cellOf[hi + 1] : -1;
      const L = len + 1;
      if (loAnc >= 0 && hiAnc >= 0 && DIST[loAnc * n + hiAnc] > L) return null;
      // 体积计数可以提前停，但**绝不允许停在 len 以下**：只按"当前最优体积"停会低估一个
      // 真实体积大于 len 的 gap，于是把一张已知有解的盘报成不可行（屏冒烟时抓到过）。
      const cutoff = (found ? bVol : 0) > len ? (found ? bVol : 0) : len;
      let vol = 0;
      for (let c = 0; c < n; c++) {
        if (used[c]) continue;
        let okc;
        if (loAnc >= 0 && hiAnc >= 0) {
          const dA = DIST[c * n + loAnc], dB = DIST[c * n + hiAnc];
          const tmin = dA < 1 ? 1 : dA;
          const tmax = (L - dB) > len ? len : (L - dB);
          okc = tmin <= tmax;
        } else if (loAnc >= 0) okc = DIST[c * n + loAnc] <= len;
        else if (hiAnc >= 0) okc = DIST[c * n + hiAnc] <= len;
        else okc = true;
        if (okc && ++vol >= cutoff) break;
      }
      if (vol < len) return null;
      let S = -1, F = -1, dir = 1, fo;
      if (loAnc >= 0 && hiAnc >= 0) {
        const oa = firstOpts(loAnc, hiAnc, len), ob = firstOpts(hiAnc, loAnc, len);
        if (oa <= ob) { S = loAnc; F = hiAnc; dir = 1; fo = oa; } else { S = hiAnc; F = loAnc; dir = -1; fo = ob; }
      } else if (loAnc >= 0) { S = loAnc; F = -1; dir = 1; fo = freeNbrs(S); }
      else if (hiAnc >= 0) { S = hiAnc; F = -1; dir = -1; fo = freeNbrs(S); }
      else { S = -1; F = -1; dir = 1; fo = countFree(); }
      if (!found || vol < bVol || (vol === bVol && (len < bLen || (len === bLen &&
        (fo < bOpts || (fo === bOpts && lo < bLo)))))) {
        found = true; bVol = vol; bLen = len; bOpts = fo; bLo = lo; bLoAnc = loAnc; bHiAnc = hiAnc;
      }
      v = hi + 1;
    }
    if (!found) return false;
    // 注意：每个节点返回**新对象**。共用一块 scratch 会让 walk() 里嵌套的 run() 覆盖外层
    // walk 还在读的那个 gap 描述子 —— 那个 bug 让裁判漏解（屏冒烟时抓到）。
    const out = { lo: bLo, hi: bLo + bLen - 1, len: bLen, vol: bVol, S: -1, F: -1, dir: 1 };
    if (bLoAnc >= 0 && bHiAnc >= 0) {
      const oa = firstOpts(bLoAnc, bHiAnc, bLen), ob = firstOpts(bHiAnc, bLoAnc, bLen);
      if (oa <= ob) { out.S = bLoAnc; out.F = bHiAnc; out.dir = 1; } else { out.S = bHiAnc; out.F = bLoAnc; out.dir = -1; }
    } else if (bLoAnc >= 0) { out.S = bLoAnc; out.F = -1; out.dir = 1; }
    else { out.S = bHiAnc; out.F = -1; out.dir = -1; }
    if (out.len > maxGapLen) maxGapLen = out.len;
    return out;
  }

  function run() {
    nodes++;
    if (nodes > nodeCap) { stopped = true; stoppedBy = 'nodes'; return; }
    if ((nodes & 255) === 0 && performance.now() - t0 > msCap) { stopped = true; stoppedBy = 'ms'; return; }
    const picked = pickGap();
    if (picked === null) { deadEnds++; return; }
    if (picked === false) { sols.push(Int32Array.from(cellOf)); return; }
    walk(picked, 0, picked.S);
  }

  function walk(gap, i, cur) {
    if (stopped || sols.length >= limit) return;
    if (i === gap.len) {
      if (gap.F >= 0 && DIST[cur * n + gap.F] !== 1) { deadEnds++; return; }
      run(); return;
    }
    const v = gap.dir > 0 ? gap.lo + i : gap.hi - i;
    nodes++;
    if (nodes > nodeCap) { stopped = true; stoppedBy = 'nodes'; return; }
    if ((nodes & 255) === 0 && performance.now() - t0 > msCap) { stopped = true; stoppedBy = 'ms'; return; }
    let opts = 0;
    if (gap.S < 0 && i === 0) {
      // 一个锚点都没有（空题面）：任何空格都可以放这个数
      for (let c = 0; c < n; c++) {
        if (used[c]) continue;
        opts++;
        used[c] = 1; cellOf[v] = c;
        const before = sols.length;
        walk(gap, i + 1, c);
        cellOf[v] = -1; used[c] = 0;
        if (sols.length === before) deadEnds++;
        if (stopped || sols.length >= limit) { if (opts >= 2) multiWay++; return; }
      }
    } else {
      const l = NB[cur];
      for (let k = 0; k < l.length; k++) {
        const c = l[k];
        if (used[c]) continue;
        if (gap.F >= 0 && DIST[c * n + gap.F] > gap.len - i) continue;
        opts++;
        used[c] = 1; cellOf[v] = c;
        const before = sols.length;
        walk(gap, i + 1, c);
        cellOf[v] = -1; used[c] = 0;
        if (sols.length === before) deadEnds++;
        if (stopped || sols.length >= limit) { if (opts >= 2) multiWay++; return; }
      }
    }
    if (opts >= 2) multiWay++;
    if (opts === 0) deadEnds++;
  }

  run();
  const ms = performance.now() - t0;
  const outcome = stopped ? 'stopped' : sols.length === 0 ? 'none' : sols.length === 1 ? 'unique' : 'multiple';
  return {
    outcome, count: sols.length, solutions: sols, nodes, ms, stopped, stoppedBy,
    multiWay, deadEnds, maxGap: maxGapLen,
    zeroBranch: outcome === 'unique' && multiWay === 0 && deadEnds === 0,
  };
}
