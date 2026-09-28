// 独立见证计数器 · 两条不做任何传播的穷举通道
//
// 它们存在的唯一理由：裁判（counter.js）如果哪天把某个约束删漏了，它会**自洽地**给出一个错的
// "unique"。对账不能靠同一个实现再跑一遍，所以本文件故意不复用 counter.js 的任何东西 ——
// 没有 gap 描述子、没有 MRV、没有 corridor 体积、没有距离下界、连"重复格"的检查都另写一份。
// 两条通道与裁判只共享 rules.js 里那份几何（NB/DIST 表）—— 那是题面本身，不是剪枝。
//
//   A（countWitnessA）：按**格子**行主序 0,1,2,… 给每格挑一个数；连续性只在"两端都已放好"的
//     那一刻检查。3×3 上它会走完 9! = 362,880 个双射，所以是真正的暴力，也是对裁判的独立读数。
//   B（countWitnessB）：按**值轴**切 gap，但 gap 的访问顺序固定为升序（绝不 MRV），每个 gap
//     在锚点的原始邻接表序上枚举全部自避王步，**完全不设距离下界**；唯一的硬性要求是最后
//     一格落在远端锚点的王邻域里。
//
// 于是三条通道的搜索顺序、分支形状、剪枝集合都不同：同一个 count 从三个独立方向读出来才叫对账。
//
// 代价：本文件慢裁判一到两个数量级，所以它只用于**抽样复核**（屏上 A 只跑每档前 4 张盘，
// 且 2000 ms / 2000 万节点下 5×5 有 3/4、6×6 与 7×7 全 4/4 是 stopped —— stopped 是"没有读数"，
// 既不算一致也不算分歧，把它算成分歧会制造假不一致，屏第一版就这么错过）。B 跑得完全部
// 120 张盘：屏上量到 AGREE 40/39/35、MISMATCH 0/0/0、其余 0/1/5 张是 stopped（2026-09-28）。
// 预算击穿 ⇒ stopped=true，"还没数完"不等于"数出来是 1"，provesUnique 的口径与裁判一致。

/** A 的默认预算：屏的 CFG.witnessNodes / CFG.witnessMs。 */
export const WITNESS_A_BUDGET = Object.freeze({ nodeCap: 20000000, msCap: 2000 });
/** B 的默认预算：屏的 CFG.witnessBNodes / CFG.witnessBMs。 */
export const WITNESS_B_BUDGET = Object.freeze({ nodeCap: 4000000, msCap: 800 });

/** 唯一性的唯一读法（与 counter.js 同一条口径，两份实现互不引用）。 */
export function provesUnique(r) {
  return r !== null && r !== undefined && r.outcome === 'unique';
}

/**
 * 逐格暴力（传播无关）：值域 1..N、每数一次、两端齐了才查连续性。
 * @returns {outcome,count,nodes,ms,stopped,solutions,reason?}
 */
export function countWitnessA(G, givenCell, opts = {}) {
  const { n, DIST } = G;
  const limit = opts.limitSolutions || 2;
  const nodeCap = opts.nodeCap ?? WITNESS_A_BUDGET.nodeCap;
  const msCap = opts.msCap ?? WITNESS_A_BUDGET.msCap;
  const t0 = performance.now();
  const valOf = new Int32Array(n).fill(-1);
  const cellOfV = new Int32Array(n + 1).fill(-1);
  const forced = new Int32Array(n);
  for (let v = 1; v <= n; v++) if (givenCell[v] >= 0) {
    const c = givenCell[v];
    if (forced[c]) return { outcome: 'none', reason: 'dup-given', count: 0, nodes: 0, ms: 0, stopped: false, solutions: [] };
    forced[c] = v;
  }
  let nodes = 0, stopped = false;
  const sols = [];
  function ok(v, c) {
    if (v > 1 && cellOfV[v - 1] >= 0 && DIST[c * n + cellOfV[v - 1]] !== 1) return false;
    if (v < n && cellOfV[v + 1] >= 0 && DIST[c * n + cellOfV[v + 1]] !== 1) return false;
    return true;
  }
  function rec(c) {
    if (stopped || sols.length >= limit) return;
    nodes++;
    if (nodes > nodeCap) { stopped = true; return; }
    if ((nodes & 8191) === 0 && performance.now() - t0 > msCap) { stopped = true; return; }
    if (c === n) {
      const snap = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) snap[valOf[i]] = i;
      sols.push(snap); return;
    }
    if (forced[c]) {
      const v = forced[c];
      if (cellOfV[v] >= 0 || !ok(v, c)) return;
      valOf[c] = v; cellOfV[v] = c;
      rec(c + 1);
      valOf[c] = -1; cellOfV[v] = -1;
      return;
    }
    for (let v = 1; v <= n; v++) {
      if (cellOfV[v] >= 0) continue;
      if (givenCell[v] >= 0) continue;             // 这个数属于别的格
      if (!ok(v, c)) continue;
      valOf[c] = v; cellOfV[v] = c;
      rec(c + 1);
      valOf[c] = -1; cellOfV[v] = -1;
      if (stopped || sols.length >= limit) return;
    }
  }
  rec(0);
  const ms = performance.now() - t0;
  const outcome = stopped ? 'stopped' : sols.length === 0 ? 'none' : sols.length === 1 ? 'unique' : 'multiple';
  return { outcome, count: sols.length, solutions: sols, nodes, ms, stopped };
}

/**
 * 逐 gap 暴力（固定升序、零剪枝）：gap 顺序 = 值轴升序，走法顺序 = 邻接表原始下标序。
 * 空题面（两端都没有锚点）无法用"定长走法"表达，本文件直接给 stopped（没有读数），
 * 而不是偷偷换成另一种枚举 —— 换读法就不是独立见证了对账的意义。
 * @returns {outcome,count,nodes,ms,stopped,solutions,reason?}
 */
export function countWitnessB(G, givenCell, opts = {}) {
  const { n, NB, DIST } = G;
  const limit = opts.limitSolutions || 2;
  const nodeCap = opts.nodeCap ?? WITNESS_B_BUDGET.nodeCap;
  const msCap = opts.msCap ?? WITNESS_B_BUDGET.msCap;
  const t0 = performance.now();
  const cellOf = new Int32Array(n + 1).fill(-1);
  const used = new Uint8Array(n);
  for (let v = 1; v <= n; v++) if (givenCell[v] >= 0) {
    const c = givenCell[v];
    if (used[c]) return { outcome: 'none', reason: 'dup-given', count: 0, nodes: 0, ms: 0, stopped: false, solutions: [] };
    cellOf[v] = c; used[c] = 1;
  }
  const gaps = [];
  {
    let v = 1;
    while (v <= n) {
      if (cellOf[v] >= 0) { v++; continue; }
      let lo = v, hi = v;
      while (hi + 1 <= n && cellOf[hi + 1] === -1) hi++;
      const loAnc = lo > 1 ? cellOf[lo - 1] : -1;
      const hiAnc = hi < n ? cellOf[hi + 1] : -1;
      if (loAnc < 0 && hiAnc < 0) return { outcome: 'stopped', reason: 'no-anchor', count: 0, nodes: 0, ms: 0, stopped: true, solutions: [] };
      gaps.push(loAnc >= 0
        ? { S: loAnc, F: hiAnc, vals: Array.from({ length: hi - lo + 1 }, (_, k) => lo + k) }
        : { S: hiAnc, F: loAnc, vals: Array.from({ length: hi - lo + 1 }, (_, k) => hi - k) });
      v = hi + 1;
    }
  }
  let nodes = 0, stopped = false;
  const sols = [];
  function walkGap(gi, k, cur) {
    if (stopped || sols.length >= limit) return;
    const gap = gaps[gi];
    if (k === gap.vals.length) {
      if (gap.F >= 0 && DIST[cur * n + gap.F] !== 1) return;
      nextGap(gi + 1); return;
    }
    const v = gap.vals[k];
    nodes++;
    if (nodes > nodeCap) { stopped = true; return; }
    if ((nodes & 511) === 0 && performance.now() - t0 > msCap) { stopped = true; return; }
    const l = NB[cur];
    for (let x = 0; x < l.length; x++) {
      const c = l[x];
      if (used[c]) continue;
      used[c] = 1; cellOf[v] = c;
      walkGap(gi, k + 1, c);
      cellOf[v] = -1; used[c] = 0;
      if (stopped || sols.length >= limit) return;
    }
  }
  function nextGap(gi) {
    if (stopped || sols.length >= limit) return;
    if (gi === gaps.length) {
      const snap = Int32Array.from(cellOf);
      sols.push(snap); return;
    }
    const gap = gaps[gi];
    walkGap(gi, 0, gap.S);
  }
  nextGap(0);
  const ms = performance.now() - t0;
  const outcome = stopped ? 'stopped' : sols.length === 0 ? 'none' : sols.length === 1 ? 'unique' : 'multiple';
  return { outcome, count: sols.length, solutions: sols, nodes, ms, stopped };
}
