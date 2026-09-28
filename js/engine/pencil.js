// 铅笔求解器 · 命名规则、**零分支**（不许猜、不许回溯）
//
// 它是"零猜测"这条产品承诺的**执行者**，也是选型屏 Test 1 的被试：如果它对任何有效唯一盘都
// 推得完，门槛就是恒真的，等于没承诺；屏上量到它对不可约盘 BASIC 完成 3/40、3/40、2/40
// （5/6/7 档，2026-09-28，loadavg 5.99→6.37），而同批盘最终裁判 40/40 都判得出唯一 ——
// 这个不对称就是地基：裁判要分支（zeroBranch 0/40），铅笔推不完，两者都不是恒真。
//
// 状态：每格一个候选数集合，用两个 32 位字当位图（lo=值 1..32，hi=值 33..64）。规则只做
// **删候选**或**定值**，从不引入猜测；一轮里什么都没删掉而还有格 >1 候选 = 停住（stall）。
// 值域上限 64 是位图本身的限制（出货最大 7×7=49），超出直接抛而不是静默算错。
//
//   R1 given-lock     印出来的数压成单候选格 —— 记账，不是推理，单独计数
//   R2 cell-single    只剩一个候选的格定值，该数从所有别的格删掉（all-different）
//   R3 value-single   只剩一个可放格的数定值到那里，该格其它候选全清
//   R4 support-pred   删掉 k：k>1 且 k 的王邻域里没有任何格还能放 k−1（沿链向下的弧一致性）
//   R5 support-succ   删掉 k：k<N 且 k 的王邻域里没有任何格还能放 k+1（同上，向上）
//   R6 distance-bound 删掉格 c 上的 k：若某个已定值 v 在格 d，切比雪夫(c,d) > |k−v|
//                     —— 一步链只走一格王步，链跨不过那么远的距离
//   R7 tight-corridor 两个已定值 a<b 满足 切比雪夫(A,B)==b−a ⇒ 子路径必须是测地线：
//                     持 a+t 的格必须同时满足 切比雪夫(A,c)==t 且 切比雪夫(c,B)==b−a−t，
//                     区间内其它距离球外交集上的候选一律删掉
//   R8 gap-pool       相邻两个已定值 a<b 之间需要 b−a−1 个不同格；若"能放区间内任一数"的
//                     格池恰好这么大 ⇒ 这些格只放 (a,b) 内的数，别的全清（前缀/后缀池同理）；
//                     池比需要的小 ⇒ 矛盾
//   BASIC = R2..R6，EXT = 再加 R7、R8。
//
// R1 不写进 fires（它不是推理）；fires 的下标 0..6 与 RULE_NAMES 一一对应，这个数组形状是
// 选型屏的形状，port-check 逐下标对它，所以不许重排。给人和闸读的是 ruleFires 对象
// （按 id 键，多带一个 R1=givenLocks，那是记账读数）。dead 就是屏里的 empty，改名是为了和
// 裁判的 deadEnds（搜索树死路）区分开：这里指"某格候选被清空"。
// 屏的按档求和读数（40 张/档，2026-09-28）：
//   5×5  BASIC R2 424 / R3 67 / R4 3282 / R5 2317 / R6 1874 · EXT 加 R7 51 / R8 264
//   7×7  BASIC R2 838 / R3 192 / R4 14641 / R5 9486 / R6 11208 · EXT 加 R7 208 / R8 503
// —— 注意 EXT 那两条确实**多删了位**，但完成数一点没涨（BASIC 3/40、3/40、2/40 对 EXT 3/40、
//    3/40、2/40），所以"加规则=变强"在这张表上不成立，别拿它当卖点；R7/R8 只在 EXT 跑，
//    BASIC 里那两个下标恒为 0，读 fires 数组时不要当成"规则坏了"。
//
// 可靠性审计（屏里做的，不在本模块）：每条结论都必须留在裁判那个真解的位图里，
// 屏上 soundViolations = 0/120 张（2026-09-28）—— domSnapshot 就是为那次对账留下的口子。

import { gridOf, parseSize, toGivenCell } from './rules.js';

export const RULE_NAMES = Object.freeze([
  'R2 cell-single', 'R3 value-single', 'R4 support-pred', 'R5 support-succ',
  'R6 distance-bound', 'R7 tight-corridor', 'R8 gap-pool',
]);

/** 规则名（含 R1）。fires 的下标与 RULE_NAMES 对齐，所以 R1 不在里面。 */
export const RULE_ORDER = Object.freeze(['R1', ...RULE_NAMES.map((s) => s.split(' ')[0])]);
/** BASIC 的五条：零猜测承诺里"玩家手里就有"的那部分。 */
export const BASIC_RULES = Object.freeze(['R2', 'R3', 'R4', 'R5', 'R6']);
/** EXT 比 BASIC 多出的两条；出货强度是 BASIC ∪ EXT。 */
export const EXT_RULES = Object.freeze(['R7', 'R8']);
export const FULL_RULES = Object.freeze([...BASIC_RULES, ...EXT_RULES]);

/** 两种强度；'EXT' 才是出货候选，'BASIC' 是它的对照。 */
export const STRENGTHS = Object.freeze(['BASIC', 'EXT']);

/**
 * 强度名或规则 id 数组 → 逐条开关。R1 恒开（它是"把印出来的数压成单候选"的记账，
 * 不是推理，关掉它等于把题面读丢）。
 * 为什么按**单条**门控而不是只有一个 ext 布尔：闸要能证明每条规则各自真的会开火
 * （R7 只在测地走廊上开火、R8 只在恰好等大的格池上开火），拿一个总开关验出来的
 * 只是"这一对里有东西在动"。数组形状与 BASIC/EXT 完全兼容：屏的 'EXT' 就是全开。
 */
function ruleSetOf(spec) {
  const on = { R1: true };
  for (const id of BASIC_RULES) on[id] = false;
  for (const id of EXT_RULES) on[id] = false;
  if (typeof spec === 'string') {
    if (spec === 'BASIC') for (const id of BASIC_RULES) on[id] = true;
    else if (spec === 'EXT') for (const id of FULL_RULES) on[id] = true;
    else throw new Error(`未知强度 ${spec}，只认 ${STRENGTHS.join('/')}`);
  } else if (Array.isArray(spec)) {
    for (const id of spec) {
      if (id === 'R1') continue;
      if (!(id in on)) throw new Error(`规则 id 不认识：${id}（候选 ${RULE_ORDER.join(',')}）`);
      on[id] = true;
    }
  } else throw new Error(`强度参数形状不认识：${spec}`);
  return on;
}

/** 轮数上限：一位图收敛在 49 格上远小于此，走到上限说明传播在打摆（屏同款口径，保持原值）。 */
const MAX_ROUNDS = 300;

/**
 * @param G         rules.js 的 buildGrid 产物（N ≤ 64）
 * @param givenCell Int32Array(N+1)，值→格，-1=未印
 * @param spec      'BASIC' | 'EXT' | 规则 id 数组（见 ruleSetOf）
 * @returns {solved,contradiction,undecided,dead,rounds,removals,fires,givenLocks,solution,domSnapshot}
 *   solved    全部格定值（= 不分支推完了这张盘）
 *   undecided 仍有 >1 候选的格数（难度轴上的读数：屏上它对 givens 的 Spearman 中位是
 *             −0.839 / −0.849 / −0.839（5/6/7 档，2026-09-28），且 0/40 张盘出现回升台阶，
 *             即"线索越少越推不动"单调成立，这条轴可用）
 *   dead      候选被清空、但没触发 contradiction 的格数（正常出货路径恒为 0）
 *   contradiction  第一个把盘证伪的理由字符串（规则删干净了 ⇒ 题面自相矛盾，这是**结论**不是崩溃）
 */
export function pencilSolve(G, givenCell, spec) {
  const { n, NB, DIST } = G;
  if (n > 64) throw new Error(`位图铅笔只支持 N<=64，实得 N=${n}`);
  const on = ruleSetOf(spec);
  const lo = new Uint32Array(n), hi = new Uint32Array(n);
  const fullLo = n >= 32 ? 0xFFFFFFFF : ((1 << n) - 1) >>> 0;
  const fullHi = n > 32 ? ((1 << (n - 32)) - 1) >>> 0 : 0;
  for (let i = 0; i < n; i++) { lo[i] = fullLo; hi[i] = fullHi; }
  const has = (i, v) => v <= 32 ? ((lo[i] >>> (v - 1)) & 1) : ((hi[i] >>> (v - 33)) & 1);
  const clear = (i, v) => { if (v <= 32) lo[i] &= ~((1 << (v - 1)) >>> 0); else hi[i] &= ~((1 << (v - 33)) >>> 0); };
  function size(i) {
    let x = lo[i], y = hi[i], c = 0;
    while (x) { x &= (x - 1); c++; }
    while (y) { y &= (y - 1); c++; }
    return c;
  }
  function singletonValue(i) {
    for (let v = 1; v <= n; v++) if (has(i, v)) return v;
    return -1;
  }
  let givenLocks = 0;
  for (let v = 1; v <= n; v++) if (givenCell[v] >= 0) {
    const c = givenCell[v];
    lo[c] = 0; hi[c] = 0;
    if (v <= 32) lo[c] = (1 << (v - 1)) >>> 0; else hi[c] = (1 << (v - 33)) >>> 0;
    givenLocks++;
  }
  const fires = [0, 0, 0, 0, 0, 0, 0];
  const counted = new Uint8Array(n);      // R2/R3 的落子每格只计一次
  let contradiction = null, rounds = 0, removals = 0;

  for (; rounds < MAX_ROUNDS; rounds++) {
    let fired = false;
    // ---- R2 cell-single + all-different ----
    for (let i = 0; i < n && !contradiction; i++) {
      const s = size(i);
      if (s === 0) { contradiction = 'empty-domain@' + i; break; }
      // 空格域的检出**不受开关影响**：它是"这题面没有解"的结论，不是 R2 的动作。
      if (s !== 1 || !on.R2) continue;
      if (!counted[i]) { counted[i] = 1; fires[0]++; }
      const v = singletonValue(i);
      for (let j = 0; j < n; j++) {
        if (j === i || !has(j, v)) continue;
        clear(j, v); fired = true; removals++;
        if (size(j) === 0) { contradiction = 'all-diff-killed@' + j; break; }
      }
    }
    if (contradiction) break;
    // ---- R3 value-single ----
    for (let v = 1; v <= n && !contradiction; v++) {
      let cnt = 0, where = -1;
      for (let i = 0; i < n; i++) if (has(i, v)) { cnt++; where = i; }
      if (cnt === 0) { contradiction = 'value-unplaceable-' + v; break; }
      // cnt===0 的检出同样恒开：某个数已经没有格可去 = 盘证伪，跟 R3 开不开无关。
      if (cnt !== 1 || size(where) === 1 || !on.R3) continue;
      lo[where] = 0; hi[where] = 0;
      if (v <= 32) lo[where] = (1 << (v - 1)) >>> 0; else hi[where] = (1 << (v - 33)) >>> 0;
      fired = true;
      if (!counted[where]) { counted[where] = 1; fires[1]++; }
    }
    if (contradiction) break;
    // ---- R4 / R5 support ----
    for (let i = 0; i < n && !contradiction; i++) {
      const nb = NB[i];
      for (let v = 1; v <= n; v++) {
        if (!has(i, v)) continue;
        if (v > 1 && on.R4) {
          let sup = false;
          for (let k = 0; k < nb.length; k++) if (has(nb[k], v - 1)) { sup = true; break; }
          if (!sup) { clear(i, v); fired = true; removals++; fires[2]++; if (size(i) === 0) { contradiction = 'support-killed@' + i; break; } continue; }
        }
        if (v < n && on.R5) {
          let sup = false;
          for (let k = 0; k < nb.length; k++) if (has(nb[k], v + 1)) { sup = true; break; }
          if (!sup) {
            clear(i, v); fired = true; removals++; fires[3]++;
            if (size(i) === 0) { contradiction = 'support-killed@' + i; break; }
          }
        }
      }
    }
    if (contradiction) break;
    // ---- R6 distance bound against every placed value ----
    for (let i = 0; i < n && !contradiction; i++) {
      if (size(i) !== 1 || !on.R6) continue;
      const v = singletonValue(i);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = DIST[i * n + j];
        if (d <= 1) continue;
        const kmin = Math.max(1, v - d + 1), kmax = Math.min(n, v + d - 1);
        for (let k = kmin; k <= kmax; k++) {
          if (!has(j, k)) continue;
          clear(j, k); fired = true; removals++; fires[4]++;
          if (size(j) === 0) { contradiction = 'distance-killed@' + j; break; }
        }
        if (contradiction) break;
      }
    }
    if (contradiction) break;
    // ---- EXT 两条：各自单独门控，闸才能逐条验"它真的会开火" ----
    if (on.R7 || on.R8) {
      // R7 tight corridor
      const placed = [];
      for (let i = 0; i < n; i++) if (size(i) === 1) placed.push(i);
      for (let a = 0; a < placed.length && !contradiction && on.R7; a++) for (let b = a + 1; b < placed.length; b++) {
        const A = placed[a], B = placed[b], va = singletonValue(A), vb = singletonValue(B);
        const loC = va < vb ? A : B, hiC = va < vb ? B : A;
        const loV = va < vb ? va : vb, hiV = va < vb ? vb : va;
        const gapV = hiV - loV;
        if (gapV < 2) continue;
        if (DIST[loC * n + hiC] !== gapV) continue;
        for (let j = 0; j < n; j++) {
          if (j === loC || j === hiC) continue;
          const dA = DIST[loC * n + j], dB = DIST[j * n + hiC];
          for (let k = loV + 1; k < hiV; k++) {
            if (!has(j, k)) continue;
            const t = k - loV;
            if (dA !== t || dB !== gapV - t) {
              clear(j, k); fired = true; removals++; fires[5]++;
              if (size(j) === 0) { contradiction = 'corridor-killed@' + j; break; }
            }
          }
          if (contradiction) break;
        }
        if (contradiction) break;
      }
      if (contradiction) break;
      // R8 gap pool / subset
      const placedVals = [];
      for (let v = 1; v <= n; v++) {
        for (let i = 0; i < n; i++) if (size(i) === 1 && has(i, v)) { placedVals.push(v); break; }
      }
      const bounds = [0, ...placedVals, n + 1];
      for (let z = 0; z + 1 < bounds.length && !contradiction && on.R8; z++) {
        const a = bounds[z], b = bounds[z + 1];
        const need = b - a - 1;
        if (need <= 0) continue;
        const pool = [];
        for (let j = 0; j < n; j++) {
          if (size(j) === 1) continue;
          for (let k = a + 1; k < b; k++) if (has(j, k)) { pool.push(j); break; }
        }
        if (pool.length < need) { contradiction = 'gap-pool-' + a + '-' + b; break; }
        if (pool.length !== need) continue;
        for (const j of pool) {
          for (let k = 1; k <= n; k++) {
            if (k > a && k < b) continue;
            if (!has(j, k)) continue;
            clear(j, k); fired = true; removals++; fires[6]++;
          }
          if (size(j) === 0) { contradiction = 'gap-pool-killed@' + j; break; }
        }
      }
      if (contradiction) break;
    }
    if (!fired) break;
    // 走到轮数上限：把 contradiction 抹回 null。这不是把矛盾藏起来 —— 上限只在"还在删"的时候
    // 碰到，此时 undecided 必然 >0 ⇒ solved=false，调用方读到的是"没推完"，而不是"推出矛盾"。
    // 屏就是这个口径（rounds<300），保持原样才能逐字节对上一批测量盘。
    if (rounds === MAX_ROUNDS - 1) { contradiction = null; break; }
  }

  let undecided = 0, dead = 0;
  for (let i = 0; i < n; i++) { const s = size(i); if (s > 1) undecided++; else if (s === 0) dead++; }
  const solution = new Int32Array(n + 1).fill(-1);
  for (let i = 0; i < n; i++) if (size(i) === 1) solution[singletonValue(i)] = i;
  const domSnapshot = { lo: Array.from(lo), hi: Array.from(hi) };
  const ruleFires = {};
  for (let k = 0; k < RULE_NAMES.length; k++) ruleFires[RULE_NAMES[k].split(' ')[0]] = fires[k];
  ruleFires.R1 = givenLocks;
  return {
    solved: !contradiction && undecided === 0 && dead === 0,
    contradiction, undecided, dead, rounds, removals, fires, ruleFires, givenLocks, solution, domSnapshot,
  };
}

/** 收口大小写：'7x7' / {R,C} / 已建好的 G 都吃，裸数字**不吃**。 */
function gridFromSize(size) {
  if (size && typeof size === 'object' && Number.isInteger(size.n) && Array.isArray(size.NB)) return size;
  const { R, C } = parseSize(size);
  return gridOf(R, C);
}

/**
 * 公开入口：铅笔推一把题面，返回逐规则开火数与三态读数。
 *
 * @param size  'RxC' | {R,C} | buildGrid 产物。**故意不收裸数字**：Hidato 的 N 有两种活该
 *              分开的读法（边长 7 / 格子数=值域上限 49），而 49 恰好也是"7 档的值域上界"，
 *              一个数字写进签名就会有一个闸把它读错。
 * @param clues Int32Array(N+1) 值→格，或 {v,cell}[]（rules.toGivenCell 的两副面孔）
 * @param opts  { strength = 'EXT' }，strength 也可传规则 id 数组（逐条门控，见 ruleSetOf）
 * @returns 同 pencilSolve，另带 `steps`（开火规则数，闸用它验"关掉一条规则确实少开火"）
 */
export function solve(size, clues, opts = {}) {
  const G = gridFromSize(size);
  const given = toGivenCell(G, clues);
  const spec = opts.strength ?? opts.rules ?? 'EXT';
  const r = pencilSolve(G, given, spec);
  r.steps = FULL_RULES.filter((id) => r.ruleFires[id] > 0).length;
  return r;
}

/**
 * 可靠性对账（命名规则的整条产品线只有这一个证人）：铅笔的每一个**结论**都必须落在
 * 裁判给出的那个真解上 —— 它定在格 c 的数 v 必须满足 cellOf[v]===c，而它从任何格删掉的候选
 * 都不许正好是那一格的真值（一条"健全"的规则只会删掉确实不可能的数）。
 * violations>0 ⇒ 铅笔越权，出货路径上任何用它做的难度承诺都不成立。
 * 屏上 120 张盘的读数是 soundViolations 0（2026-09-28）。
 */
export function auditAgainst(res, size, clues, cellOf) {
  const G = gridFromSize(size);
  const { n } = G;
  if (!cellOf) throw new Error('auditAgainst 需要裁判那条解（cellOf：值→格）');
  let placedElsewhere = 0, trueValueDeleted = 0, emptyDomaiCells = 0;
  for (let v = 1; v <= n; v++) if (res.solution[v] >= 0 && res.solution[v] !== cellOf[v]) placedElsewhere++;
  const dom = res.domSnapshot;
  for (let c = 0; c < n; c++) {
    let tv = -1;
    for (let v = 1; v <= n; v++) if (cellOf[v] === c) { tv = v; break; }
    if (tv > 0) {
      const inDom = tv <= 32 ? ((dom.lo[c] >>> (tv - 1)) & 1) : ((dom.hi[c] >>> (tv - 33)) & 1);
      if (!inDom) trueValueDeleted++;
    }
  }
  for (let c = 0; c < n; c++) {
    let any = dom.lo[c] !== 0 || dom.hi[c] !== 0;
    if (!any) emptyDomaiCells++;
  }
  const violations = placedElsewhere + trueValueDeleted;
  return { violations, placedElsewhere, trueValueDeleted, emptyDomaiCells };
}

