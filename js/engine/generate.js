// 出题器 · 一张"有唯一解、且挖到不可约"的 Hidato
//
// 一条盘的流水线，三步，每步都留账（与选型屏 _tmp-hidato-screen.mjs 的 produceBoard 同形，
// 2026-09-28，loadavg 5.99→6.37 —— port-check 就是拿这条流水线逐字节对回那 120 张测量盘的）：
//   1) 抽一条哈密顿路径 = 盘的**答案**（不是题面）：随机起点 + 随机序王步 DFS，带节点闸，
//      失败就重抽，一盘的抽取次数记在 receipt.draws（TIERS.attempts 就是给它定价的）。
//      生产用 randomised-Warnsdorff 变体：候选按"前向度最少"先试，同前向度的**随机键在 sort 之前
//      就抽好**（比较器不吃随机数），比较键尾数再按格号兜底。屏上同 200 个 seed 的对照：
//      朴素版接受率 130/31/4（5/6/7 档，7×7 只有 2%）、biased 版 200/200/199，且每次成功固定
//      24/35/48 个 DFS 节点（2026-09-28）—— 接受率 4/200 的朴素版会把 7×7 的出题墙钟拖成
//      一个中位数没有意义的双峰，所以生产不用它。两条都留着：换采样器等于换一批盘，
//      要能对账就得能重跑另一条。
//   2) 挖线索到不可约：把 2..N−1 按随机序逐个试删，删掉后裁判**仍证明唯一**才真删。
//      探针预算（4 万节点 / 60 ms）比出货裁判小一个数量级，因为要试 32/47/64 次（屏实测
//      31.6/46.5/63.5 次/盘）。探针击穿 ⇒ 这条线索**不许删**（keptByBudget 记一笔），
//      方向安全：最坏是多印一条线索，绝不会少印。实测击穿率 0%/1.6%/5.9%。
//   3) 出货裁判 + 不可约性复核：整盘用出货预算（TIERS.nodeCap/budgetMs）再判一次；
//      然后对每条幸存线索做一次"删了还唯一吗"的复核（QA pass，同样的预算）。
//      屏实测：复核里 7×7 有 40/1655 次探针击穿（= 那些线索"删不删得掉其实没证完"），
//      且 9/80 次"策略锁住的端点单独删掉仍唯一" —— 都不是 bug，是两条预算口径的差异，
//      所以 receipt 把它们分开记账（unproven / lockedRedundant），绝不合并成一个数字。
//
// 一张盘吃完的随机数（复现性口径，全部由 seed 串决定）：
//   一个 seed 串 = 一个 rnd（见 rng.js），路径采样和挖线索顺序**共用同一条流**，顺序即屏的顺序：
//   采样器每步抽前向度同排的键、每次重抽继续往下抽；挖线索吃一次 shuffled(2..N−1)。
//   没有任何一路随机数来自时钟、日期或环境 —— 这保证"同一串 ⇒ 同一张盘"在 node 与 Chrome
//   上是同一条定理，而不是一次观察。
//
// 端点 1 与 N 从不调探针：规则口径见 rules.js 的「端点不变量」一节。**注意理由的方向**：
// 对合 k → N+1−k 会把"印在格 d 的数 v"变成"印 N+1−v 在同一格"，所以**只印一个端点就已经**破掉
// 对称；"两个端点都不印 ⇒ 镜像必是第二个解"是错的（本文件旧版就这么写过，rules.js 同一节里
// 已把它钉掉：内部只要有一条 v 的镜像没印在同一格，对称就破了）。端点不进候选池因此是**成例策略**
// （Cross+A 的题面印两个端点），不是唯一性的前提条件。
//
// 成本口径（TIERS 的数就按这个测；每个数都是 SAMPLES=60 跑 tools/balance.mjs 量出来的）：
//   band      = 每盘**生产路径裁判调用次数**的区间。本品类里它是恒等式：挖 (n−2) 条探针 +
//               1 次证书 + 1 次出货 = n 次，实测三档 60 张盘 min=max=n ⇒ 表写死 [n, n]。
//               每盘抽路径的次数（receipt.draws）恒等于 1（没有拒绝采样），记在 attempts 里。
//   ladder    = 出货沿密度梯走几层，随盘变，所以取下界 1 / 上界 ceil(p95 × 1.6)。
//               下界不套"中位×0.4"：那会把实测到的最小层数砍在表外，SAMPLES 一改就一绿一红。
//   budgetMs  = **生产路径上每一次裁判调用**的 ms 的 p95 定价（挖线索探针 + 出货裁判，
//               不含第 3 步的 QA 复核，那一趟是 QA 不是出货），公式取 max(10, ceil(p95×4) 取整到 10)
//   毫秒类的量都必须取尾巴，不许中位×2：出题墙钟在本组织是双峰的（选型屏 produce ONE board
//   5×5 中位 0.83 / p95 2.83 / max 4.14 ms 就是这个形状）。计数的量（band/ladder/attempts）没有
//   双峰问题，它们是纯函数读数 —— 这也是 band 敢写成死区间 [n,n] 的原因。

import { makeRng, shuffled } from './rng.js';
import { buildGrid, droppableValues, givensFromSeq, cellOfFromSeq } from './rules.js';
import { countSolutions, provesUnique } from './counter.js';
import { pencilSolve } from './pencil.js';
import { countWitnessA, countWitnessB } from './witness.js';

// 这里**不**写 `import { performance } from 'node:perf_hooks'`：`node:` 前缀的说明符在浏览器里
// 解不开，整个模块图会在第一条语句上死掉。`performance` 在 node ≥16 与浏览器都是全局，同一个
// 钟、同一个 performance.now()，所以 ms 读数与换行之前同源 —— 少一行 import 不是放宽口径，
// 是让这段口径真的能在浏览器里被执行一次。

// ── 采样器 ──────────────────────────────────────────────────────────────────
/** 每次抽样的节点闸：屏的 CFG.accNodeCap。命中它就当这次抽取失败重抽，不参与判定形状。 */
export const SAMPLE_NODE_CAP = 200000;

/** 朴素版：随机起点 + 每格一次随机邻接序（compare 用，不是生产）。 */
export function sampleHamiltonPath(G, rnd, nodeCap = SAMPLE_NODE_CAP) {
  const { n, NB } = G;
  const used = new Uint8Array(n);
  const seq = new Int32Array(n);              // seq[d] = 数 d+1 所在的格
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = shuffled(NB[i], rnd);
  const start = (rnd() * n) | 0;
  let nodes = 0, aborted = false;
  function dfs(cell, d) {
    used[cell] = 1; seq[d] = cell;
    if (d === n - 1) return true;
    nodes++;
    if (nodes > nodeCap) { aborted = true; return false; }
    const list = order[cell];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (used[j]) continue;
      if (dfs(j, d + 1)) return true;
      if (aborted) return false;
    }
    used[cell] = 0;
    return false;
  }
  const ok = dfs(start, 0) && !aborted;
  return ok ? { ok: true, seq: Int32Array.from(seq), nodes } : { ok: false, nodes, aborted };
}

/**
 * 生产版：同一条随机流，但候选按前向度（未访问王邻格数）升序试 —— 空间填充型路径多、
 * 长直跑少，接受率从 4/200 抬到 199/200（7×7，2026-09-28）。
 * 随机键在 sort **之前**抽（`keyed.push([j, degOf(j), rnd()])`），比较器是纯函数
 * (前向度, 键, 格号) —— 这一条是本组织的硬规矩：比较器吃随机数的话 node 与 Chrome
 * 会挑出两张不同的盘。
 */
export function sampleHamiltonPathBiased(G, rnd, nodeCap = SAMPLE_NODE_CAP) {
  const { n, NB } = G;
  const used = new Uint8Array(n);
  const seq = new Int32Array(n);
  let nodes = 0, aborted = false;
  function degOf(j) { let k = 0; const l = NB[j]; for (let x = 0; x < l.length; x++) if (!used[l[x]]) k++; return k; }
  function dfs(cell, d) {
    used[cell] = 1; seq[d] = cell;
    if (d === n - 1) return true;
    nodes++;
    if (nodes > nodeCap) { aborted = true; return false; }
    const l = NB[cell];
    const keyed = [];
    for (let x = 0; x < l.length; x++) {
      const j = l[x];
      if (used[j]) continue;
      keyed.push([j, degOf(j), rnd()]);            // 随机键在排序之前抽完
    }
    keyed.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
    for (let k = 0; k < keyed.length; k++) {
      if (dfs(keyed[k][0], d + 1)) return true;
      if (aborted) return false;
    }
    used[cell] = 0;
    return false;
  }
  const start = (rnd() * n) | 0;
  const ok = dfs(start, 0) && !aborted;
  return ok ? { ok: true, seq: Int32Array.from(seq), nodes } : { ok: false, nodes, aborted };
}

/** 采样器选择：生产=biased；naive 只留给对照（换采样器 = 换一批盘，必须能重跑）。 */
export function samplePath(G, rnd, opts = {}) {
  const sampler = opts.sampler || 'biased';
  const nodeCap = opts.nodeCap ?? SAMPLE_NODE_CAP;
  return sampler === 'naive' ? sampleHamiltonPath(G, rnd, nodeCap) : sampleHamiltonPathBiased(G, rnd, nodeCap);
}

/** 挖线索探针的默认预算（屏的 CFG.carveNodes / CFG.carveMs；三档同一个数，见 TIERS 注释）。 */
export const CARVE_PROBE = Object.freeze({ nodeCap: 40000, msCap: 60 });

/**
 * 挖到逐条不可约：随机序试删 2..N−1，删掉后裁判**证明**唯一才留这个删。
 * 端点根本不进候选（droppableValues），理由见文件头与 rules.js。
 * @param acc 观察回调 acc(result, 'carve')，不参与任何判定；账本要落进 TIERS 定价。
 */
export function carveIrreducible(G, seq, rnd, acc = () => {}, opts = {}) {
  const n = G.n;
  const given = givensFromSeq(seq, n);
  const order = shuffled(droppableValues(n), rnd);
  const dropOrder = [];
  const keptBudgetVals = [];
  const probe = { nodeCap: opts.carveNodeCap ?? CARVE_PROBE.nodeCap, msCap: opts.carveMsCap ?? CARVE_PROBE.msCap };
  let probed = 0, keptByMultiple = 0, keptByBudget = 0;
  for (const v of order) {
    if (given[v] < 0) continue;
    const save = given[v];
    given[v] = -1;
    const r = countSolutions(G, given, probe);
    acc(r, 'carve');
    probed++;
    if (r.outcome === 'unique') dropOrder.push(v);
    else {
      given[v] = save;
      if (r.outcome === 'stopped') { keptByBudget++; keptBudgetVals.push(v); } else keptByMultiple++;
    }
  }
  return { given, dropOrder, probed, keptByMultiple, keptByBudget, keptBudgetVals };
}

/**
 * 盘指纹：FNV-1a 扫 (格网形状, 题面 v→格, 解 v→格) 三段字符串。
 * 为什么拿指纹当验收：**题面条数相同不等于同一张盘**，端口只要把 gap 顺序、洗牌次数或
 * 邻接表次序挪动一格，指纹就变，而条数/分布可能看起来一模一样。屏上那 120 行的第 36 列
 * 就是这个函数算的（串与分隔符逐字符照抄，连 'R5C5' 前缀都没改），所以 tools/port-check.mjs
 * 能对回它。
 */
export function fingerprint(G, given, cellOf) {
  let h = 2166136261 >>> 0;
  const push = (x) => { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
  push('R' + G.R + 'C' + G.C);
  for (let v = 1; v <= G.n; v++) push('g' + v + ':' + given[v]);
  for (let v = 1; v <= G.n; v++) push('s' + v + ':' + cellOf[v]);
  return (h >>> 0).toString(16);
}

/**
 * 一张盘的完整流水线。
 * @param G       rules.js 的 buildGrid 产物
 * @param seedStr 完整 seed 串（生产是 hidato|<size>|<n>；port-check 传屏的 screen|<size>|<i>）
 * @param opts    {carveNodeCap, carveMsCap, nodeCap, msCap, sampler, accNodeCap, maxDraws, acc}
 * @returns {fail?} 或 {given,path,dropOrder,survivors,ref,draws,...,stillUnique,unproven,lockedRedundant}
 *   裁判解 solCell 由调用方从 ref.solutions[0] 取 —— **不要**拿 path 当答案：
 *   挖完线索后 path 仍是唯一解才成立，而这个事实正是 ref 要证的，用 ref 的那张才是自证的。
 */
export function produceBoard(G, seedStr, opts = {}) {
  const n = G.n;
  const acc = opts.acc || (() => {});
  const rnd = makeRng(seedStr);
  const maxDraws = opts.maxDraws ?? 300;            // 超过就认输：屏的同一根上限
  // opts 不给就直接用 counter.js 的 REFEREE_BUDGET（与屏口径同值），不在这里再抄一遍数字。
  const referee = { nodeCap: opts.nodeCap, msCap: opts.msCap };
  const t0 = performance.now();
  let path = null, draws = 0;
  while (!path) {
    draws++;
    const s = samplePath(G, rnd, { sampler: opts.sampler, nodeCap: opts.accNodeCap ?? SAMPLE_NODE_CAP });
    if (s.ok) path = s.seq;
    else if (draws > maxDraws) return { fail: 'path', draws };
  }
  const tPath = performance.now() - t0;
  const carved = carveIrreducible(G, path, rnd, acc, { carveNodeCap: opts.carveNodeCap, carveMsCap: opts.carveMsCap });
  const given = carved.given, dropOrder = carved.dropOrder;
  const tCarve = performance.now() - t0;
  const ref = countSolutions(G, given, referee);
  acc(ref, 'final');                               // 屏没把最终裁判喂进 acc；这里喂，账才齐
  const tRef = performance.now() - t0;
  let stillUnique = 0, stillUniqueBudgetKept = 0, unproven = 0, lockedRedundant = 0;
  const budgetKept = new Set(carved.keptBudgetVals);   // 只因探针 STOPPED 才留下的线索
  const survivors = [];
  for (let v = 1; v <= n; v++) if (given[v] >= 0) survivors.push(v);
  // QA 复核（每条幸存线索试删一次）与探针不同，它**不改题面**，所以 confirm=false 不影响
  // 任何一张盘的形状，只省下屏实测 p95 85.63 ms 那一趟。生产默认不开，balance 开着当红线。
  if (opts.confirm !== false) for (const v of survivors) {
    const save = given[v];
    given[v] = -1;
    // 复核用**与出货裁判同一个预算**，所以这里的 'stopped' 读作"在产品预算内没能证伪这次删除"。
    const r2 = countSolutions(G, given, referee);
    const locked = v === 1 || v === n;              // 探针从不碰端点（策略锁，见文件头）
    if (r2.outcome === 'unique') {
      if (locked) lockedRedundant++;
      else if (budgetKept.has(v)) stillUniqueBudgetKept++;   // 可归因于探针预算
      else stillUnique++;                                     // 这一条才是不可约性 bug，必须为 0
    } else if (r2.outcome === 'stopped') unproven++;
    given[v] = save;
    acc(r2, 'confirm');
  }
  const tAll = performance.now() - t0;
  return {
    given, path, dropOrder, survivors, ref, draws, seed: seedStr,
    tPath, carveMs: tCarve - tPath, refereeMs: tRef - tCarve,
    confirmMs: tAll - tRef, tCarve, tRef, tAll,
    stillUnique, stillUniqueBudgetKept, unproven,
    lockedRedundant, keptBudgetVals: carved.keptBudgetVals.length,
    probed: carved.probed, keptByMultiple: carved.keptByMultiple, keptByBudget: carved.keptByBudget,
  };
}

// ── 密度梯（出货盘在这上面选，不在不可约盘上选）────────────────────────────
/**
 * 把挖掉的线索按 **dropOrder 的逆序**一条条放回，得到一串越来越密的 rung。
 * 为什么非有这一层：不可约盘（屏实测中位 8/12/17 条线索 = 32% / 33% / 35% 的格）对命名规则
 * 铅笔来说**推不完** —— 屏上 120 张里只有 3/3/2 张被 BASIC 推完（2026-09-28）。把那种盘直接
 * 交给玩家，"零猜测"就是假话：他必然要在某一步猜。所以出货的是**第一个 BASIC 推得完的 rung**，
 * 它严格比不可约盘密（屏实测出货线索中位 14/20/28 = 56% / 56% / 57% 的格）。
 * 这个数会写进 README，不许藏在"线索最少化"这种好听的说法后面。
 *
 * 反向放回一条都不动随机流（不用 rnd），所以加这一层不影响 port-check 对屏的指纹。
 * 走到第一个推得完的层就**停**：屏为了量整条梯把 33 层都走了一遍，它那 17.85 ms 的梯行走
 * 成本不是生产的成本，别抄进 TIERS。
 *
 * @param opts.strength  'BASIC'（出货口径）| 'EXT' | 规则 id 数组
 * @param opts.walkAll   true = 把整条梯走完再停。**只有闸用**：生产只要第一个推得完的层，
 *                       但难度轴的单调性（undecided 随 givens 升序不回升）必须在整条梯上读，
 *                       屏那 655/938/1298 次梯行走就是 walkAll 口径，别拿生产的层数去对它。
 * @returns {rungs, shipIdx, solved, strength, ms, steps}  rungs[k] = {givens, undecided, solved, rounds, removals, ruleFires, g}
 *   shipIdx = 第一个 solved 的层号（0 = 不可约盘自己就够）；整条梯推不完 ⇒ solved=false。
 *   调用方**不许**退到"整盘印出来"那一层当出货 —— 那是零推理的废话盘，承诺直接归零。
 */
export function ladderRungs(G, board, opts = {}) {
  const n = G.n;
  const strength = opts.strength || 'BASIC';
  const rev = board.dropOrder.slice().reverse();
  const t0 = performance.now();
  const rungs = [];
  let solved = false;
  for (let k = 0; k <= rev.length; k++) {
    const g = Int32Array.from(board.given);
    for (let z = 0; z < k; z++) g[rev[z]] = board.path[rev[z] - 1];
    const p = pencilSolve(G, g, strength);
    let cnt = 0;
    for (let v = 1; v <= n; v++) if (g[v] >= 0) cnt++;
    rungs.push({ givens: cnt, undecided: p.undecided, solved: p.solved, rounds: p.rounds, removals: p.removals, ruleFires: p.ruleFires, g });
    if (p.solved) { solved = true; if (!opts.walkAll) break; }
  }
  const first = rungs.findIndex((r) => r.solved);
  return { rungs, shipIdx: first < 0 ? rungs.length - 1 : first, solved, strength, ms: performance.now() - t0, steps: rungs.length };
}

/**
 * 出货入口（一张盘的全部生产路径）：采样 → 挖到不可约 → 不可约盘裁判（证书）→ 密度梯 →
 * **梯上那一层**再判一次唯一性。第 3 步的 N 条复核探针（QA pass）默认**不跑**：屏实测它
 * p95 85.63 ms / 整盘 134.49 ms（7×7，2026-09-28），是出货整盘 45.25 ms 的三倍，而它买到的
 * 东西 balance 已经在闸里批量买过了。opts.confirm=true 开回来（R5 红线要用）。
 *
 * fail 只有四类，各记各的账，一个都不在这里重试：
 *   'path'     300 次抽不到哈密顿路径（屏实测 draws 中位 = 1，几乎不可能）
 *   'cert-*'   不可约盘的裁判没证明唯一（stopped / multiple / none）—— 出题器 bug 级
 *   'ladder'   整条密度梯铅笔都推不完（屏实测 0/120；出货不退回满盘层）
 *   'ship-*'   出货层的裁判没证明唯一 —— 线索变密只会让解集变小，这条按构造不可能成立，
 *              出现了就是裁判或梯子的实现坏了，必须让它红，不许在这儿悄悄换 seed 重试
 * @returns {ok, fail?, seed, board, lad, ship, solution, fingerprint, certFingerprint, draws, totalMs}
 */
export function generateOn(G, seedStr, opts = {}) {
  const strength = opts.strength || 'BASIC';
  const acc = opts.acc || (() => {});
  const referee = { nodeCap: opts.nodeCap, msCap: opts.msCap };
  const b = produceBoard(G, seedStr, { ...opts, acc, confirm: opts.confirm ?? false });
  if (b.fail) return { ok: false, fail: 'path', draws: b.draws, seed: seedStr, receipt: b };
  if (!provesUnique(b.ref)) return { ok: false, fail: 'cert-' + b.ref.outcome, draws: b.draws, seed: seedStr, receipt: b, board: b };
  const lad = ladderRungs(G, b, { strength });
  if (!lad.solved) return { ok: false, fail: 'ladder', draws: b.draws, seed: seedStr, lad, receipt: b, board: b };
  const rung = lad.rungs[lad.shipIdx];
  const shipGiven = rung.g;
  const tShip = performance.now();
  const ref = countSolutions(G, shipGiven, referee);
  acc(ref, 'ship');
  const shipMs = performance.now() - tShip;
  if (!provesUnique(ref)) {
    return { ok: false, fail: 'ship-' + ref.outcome, draws: b.draws, seed: seedStr, lad, receipt: b, board: b, shipMs };
  }
  const solution = ref.solutions[0];
  return {
    ok: true, seed: seedStr, board: b, lad, ref, draws: b.draws, solution,
    ship: {
      given: shipGiven, givens: rung.givens, rung: lad.shipIdx, undecided: rung.undecided,
      rounds: rung.rounds, removals: rung.removals, ruleFires: rung.ruleFires,
      steps: lad.steps, ladderMs: lad.ms, refereeMs: shipMs, ref,
    },
    fingerprint: fingerprint(G, shipGiven, solution),
    certFingerprint: fingerprint(G, b.given, solutionCellOf(b)),
    totalMs: b.tPath + b.carveMs + b.refereeMs + lad.ms + shipMs,
  };
}

/**
 * 独立见证对账（抽样复核用，**不在生产路径上**）：裁判与一条零传播通道给同一个读数才叫读到位。
 * witness='A' 走逐格暴力（7×7 上 2000 ms 内跑不完，屏实测 stopped 4/4 —— stopped 是"没有读数"，
 * 既不算一致也不算分歧，把它算成分歧会造出假不一致）；默认 'B' 逐 gap 暴力，屏上 120/120 能跑完。
 */
export function crossCheck(G, given, opts = {}) {
  const ref = countSolutions(G, given, opts);
  const wo = opts.witnessOpts || {};
  const w = opts.witness === 'A' ? countWitnessA(G, given, wo) : countWitnessB(G, given, wo);
  const verdict = w.outcome === 'stopped' ? 'no-reading' : (w.outcome === ref.outcome ? 'agree' : 'MISMATCH');
  return { referee: ref, witness: w, verdict, channel: opts.witness === 'A' ? 'A' : 'B' };
}

// ── 档位表 ──────────────────────────────────────────────────────────────────
// 每个区间的含义见文件头「成本口径」一节。这张表**被闸核对**（tools/balance.mjs 红线 I 断
// band/ladder 必须包住当次样本），不是抄在注释里的读数：
//   SAMPLES=60 node tools/balance.mjs   ← 回填用的大样本
//   node tools/balance.mjs              ← 默认 12；CI 用 24
//
// 下表四个数全部来自本机 2026-09-29 的一次 `SAMPLES=60 node tools/balance.mjs`
// （node v26.8.1，loadavg 前 { 4.05 3.82 4.28 } / 后 { 3.96 3.81 4.28 }，180/180 出货，
//  红线 A–H 全绿）。同一台机器重跑同一条命令应当逐位复现这些读数：
//   band      每盘生产路径裁判调用 min=max=格数（25 / 36 / 49）⇒ 写死 [n, n]
//   ladder    出货层数 p95 = 11 / 14 / 23 ⇒ 上界 ceil(p95×1.6) = 18 / 23 / 37（实测最大 14 / 15 / 27）
//   attempts  每盘抽路径次数 三档中位/p95/max 全 = 1 ⇒ [1, 1]（biased 采样器 180 张盘零重抽）
//   budgetMs  生产路径单次裁判 p95 = 0.08 / 0.50 / 1.85 ms ⇒ max(10, ceil(p95×4/10)×10) = 10 ms 三档同值
//
// 击穿（红线 G 的读数，同一趟 60 样本）：出货侧 final/ship 三档各 **0** 次；carve 探针
// 2/1380、24/2040、145/2820 次，且**全部归因到 nodeCap**（msCap 0 次、归因不明 0 次，G2/G3 断的就是
// 这两个"必须 0"和"两条记账相等"）。这就是 budgetMs=10 敢写进出货表的理由：**ms 闸没参与判定**
// ⇒ 毫秒不是盘形状的自变量 ⇒ "同一 seed 串 → 同一张盘"仍是定理。这句话以前只写在注释里，
// 现在由 counter.js 的 stoppedBy 字段交回归因、由 G2 断言；nodeCap 掐的击穿只让盘**更密**
// （探针来不及证伪就不删这条线索），方向安全。
// 余量最薄的是 7×7 的 ms 那一头：单次裁判实测 max 5.18 ms vs 10 ms = 1.9 倍，比 zebra 那批的
// 30 倍薄得多 —— Hidato 的解是全局链，尾巴就是重 25 倍。慢一倍的机器会让 ms 闸真的触发，
// 届时 G2 直接红，那一档必须重测，不许把这里的 10 抄过去当结论。
// nodeCap=250000 是出货侧的第二道闸，实测最贵的是**证书裁判**（不可约盘那一趟）：
// 27467 / 38038 / 39770 节点 ⇒ 余量 9.1× / 6.6× / 6.3×（出货层那趟只有 5467 / 20471 / 20819）。
// nodeCap 先到比 ms 先到安全，因为节点数是纯函数的量。
//
// carve 那一档保持屏口径 40000 节点 / 60 ms **不分档**：这是唯一一处"改了就会换一批盘"的
// 预算，指纹参照物（tools/port-check.mjs 对回的选型屏 120 行）是在这个口径下量出来的；
// 按档收紧它等于改采样语义，得先重跑选型屏。
//
// 屏（2026-09-28，loadavg 5.99→6.37，每档 40 张）的读数用于对照：不可约线索中位
// 8.63 / 12.55 / 16.55 条（34.5% / 34.9% / 33.8% 的格），出题墙钟 p95 2.83 / 39.07 / 116.14 ms。
export const TIERS = Object.freeze([
  {
    key: '5x5', label: '入门 · 5×5（25 格）', R: 5, C: 5, n: 25,
    band: [25, 25], budgetMs: 10, nodeCap: 250000,
    attempts: [1, 1], ladder: [1, 18], shipStrength: 'BASIC',
    carve: { nodeCap: 40000, msCap: 60 },
    // SAMPLES=60 实测：每盘裁判调用恒 25 次 · 单次 p95 0.08/max 1.05 ms · 梯层数 p95 11/max 14
    // 击穿 2/1380（全 nodeCap）· 证书裁判 max 27467 节点（9.1× 余量）· 零分支证明 13/60
    // 屏 2026-09-28 对照：不可约线索 8.63 条(34.5%) · 出货裁判 p95 0.12/max 0.22 ms · 出题 p95 2.83 ms
  },
  {
    key: '6x6', label: '进阶 · 6×6（36 格）', R: 6, C: 6, n: 36,
    band: [36, 36], budgetMs: 10, nodeCap: 250000,
    attempts: [1, 1], ladder: [1, 23], shipStrength: 'BASIC',
    carve: { nodeCap: 40000, msCap: 60 },
    // SAMPLES=60 实测：每盘裁判调用恒 36 次 · 单次 p95 0.50/max 2.91 ms · 梯层数 p95 14/max 15
    // 击穿 24/2040（全 nodeCap）· 证书裁判 max 38038 节点（6.6× 余量）· 零分支证明 4/60
    // 屏 2026-09-28 对照：不可约线索 12.55 条(34.9%) · 出货裁判 p95 1.05/max 1.47 ms · 出题 p95 39.07 ms
  },
  {
    key: '7x7', label: '挑战 · 7×7（49 格）', R: 7, C: 7, n: 49,
    band: [49, 49], budgetMs: 10, nodeCap: 250000,
    attempts: [1, 1], ladder: [1, 37], shipStrength: 'BASIC',
    carve: { nodeCap: 40000, msCap: 60 },
    // SAMPLES=60 实测：每盘裁判调用恒 49 次 · 单次 p95 1.85/max 5.18 ms · 梯层数 p95 23/max 27
    // 击穿 145/2820（全 nodeCap）· 证书裁判 max 39770 节点（6.3× 余量）· 零分支证明 6/60
    // 这一档是 ms 余量最薄的一张：10 − 5.18 ms，负载再高一倍就会改盘 ⇒ 重测再说（见上）。
    // 屏 2026-09-28 对照：不可约线索 16.55 条(33.8%) · 出货裁判 p95 2.73/max 4.76 ms · 出题 p95 116.14 ms
  },
]);

export function tierOf(key) {
  const t = TIERS.find((x) => x.key === key);
  if (!t) throw new Error(`未知档位 ${key}，出货表只有 ${TIERS.map((x) => x.key).join(' / ')}`);
  return t;
}

/** 格网缓存：同一档的 N² 距离表只摊一次（1225 个 uint8，热路径上反复查）。 */
const GRID_CACHE = new Map();
export function gridFor(tier) {
  const key = tier.key;
  let g = GRID_CACHE.get(key);
  if (!g) { g = buildGrid(tier.R, tier.C); GRID_CACHE.set(key, g); }
  return g;
}

/**
 * 出货盘的"答案格"（v→格）：优先用裁判**带回来**的那个解，裁判一个解都没数到才退回采样路径。
 * 这条顺序是有理由的：挖完线索后的 path 是不是合法解，正是 ref 要证的事；拿 path 当答案去
 * 自证等于把出题器记的账当证人（本组织在别的品类上栽过一次）。port-check 与 produce 共用
 * 这一个读法，指纹才对得上屏的第 36 列。
 */
export function solutionCellOf(board) {
  const n = board.given.length - 1;
  return board.ref && board.ref.solutions.length ? board.ref.solutions[0] : cellOfFromSeq(board.path, n);
}

/**
 * 按档位出题。band/budgetMs 从 TIERS 来，调用方一律不许自带预算 —— 自带就等于重新定价，
 * 而那张价格表是被 balance 量出来、被 DESIGN 引用的。
 */
export function generate(tierKey, seed, opts = {}) {
  const tier = tierOf(tierKey);
  const G = gridFor(tier);
  const seedStr = `hidato|${tier.key}|${seed}`;
  const out = generateOn(G, seedStr, {
    nodeCap: tier.nodeCap, msCap: tier.budgetMs,
    carveNodeCap: tier.carve.nodeCap, carveMsCap: tier.carve.msCap,
    strength: tier.shipStrength ?? opts.strength ?? 'BASIC',
    confirm: opts.confirm, acc: opts.acc,
  });
  out.tier = tier.key;
  return out;
}

/**
 * 只出"不可约证书盘"的入口：跳过密度梯，返回不可约盘本身。
 * 它**不是**出货路径（那种盘命名铅笔推不完，理由见 ladderRungs），留给两件事用：
 * balance 的不可约性红线（R5），以及任何想看"线索最少能到几条"的读数。
 */
export function produce(tierKey, seed, opts = {}) {
  const tier = tierOf(tierKey);
  const G = gridFor(tier);
  const seedStr = `hidato|${tier.key}|${seed}`;
  const b = produceBoard(G, seedStr, {
    nodeCap: tier.nodeCap, msCap: tier.budgetMs,
    carveNodeCap: tier.carve.nodeCap, carveMsCap: tier.carve.msCap,
    confirm: opts.confirm ?? true, acc: opts.acc,
  });
  if (b.fail) return { ok: false, fail: b.fail, draws: b.draws, tier: tier.key, seed: seedStr, board: b };
  return {
    ok: provesUnique(b.ref), tier: tier.key, seed: seedStr, board: b,
    givens: b.survivors.length, draws: b.draws,
    solution: solutionCellOf(b), fingerprint: fingerprint(G, b.given, solutionCellOf(b)),
  };
}

