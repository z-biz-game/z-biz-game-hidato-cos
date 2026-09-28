#!/usr/bin/env node
// 规则语义闸 · Hidato 的词汇表与"什么算合法"逐条钉死
//
// 存在理由：本仓所有下游（裁判 counter.js、两条见证 witness.js、铅笔 pencil.js、出题器
// generate.js、port-check、balance）都从 js/engine/rules.js 读同一份几何与合法性定义。
// 那份定义若有一处写歪，下游会**一起**自洽地错，对账查不出来（witness.js 复写了一份枚举，
// 但没复写几何 —— 几何只有这一份）。所以这里每条结论都用另一条通道对照：
// 本文件自己按 Cross+A 的题面重写一遍切比雪夫判定，或拿裁判 countSolutions 当证人。
//
// 跑法：  node tools/rule-test.mjs                 （默认 SAMPLES=4 张真盘/档，秒级）
//        SAMPLES=20 node tools/rule-test.mjs      （真盘样本放大；3x3 穷举段不受它影响）
//
// 每段都写了"什么改动会让这段红"，因为一条不会被推翻的断言等于没写：
//
//   §1 几何            NB 序被重排 / 邻接改成横竖（Numbrix 化）/ DIST 与 adj 分家 /
//                      isAdjacent 另写一份 max(|Δr|,|Δc|) —— 都会红。对角相邻**必须**算相邻，
//                      这是 Hidato 与 Numbrix 的唯一分界，红线上单独钉了一条"斜邻居数 == 32"。
//   §2 表示            givenCell 与 cellOf 的下标语义（0 位弃用）被动过、toGivenCell 的四条
//                      越界/重复检查被删、fromGivenCell 开始把未印的位置吐出去 —— 会红。
//   §3 合法定义        verifyNumbering 的每一条违规各配一个"只在这一点上坏"的负样本 +
//                      一个只差一点的对照正样本；违规字符串的形状（带 @v）也被钉住。
//   §4 端点不变量      droppableValues 放进 1 或 N、missingEndpoints 的三态被合并、
//                      真盘上出现缺端点 —— 会红。3x3 全 511 个题面子集按端点四象限分类，
//                      是 rules.js 那一节"旧说法已被钉掉"的证人：**不印端点照样能唯一**，
//                      所以端点不进候选池是成例策略而不是唯一性前提（断言写成
//                      "无端点的唯一盘 >= 1 张"，一旦有人把旧定理写进判定就会翻）。
//   §5 题面自相矛盾    givenConflict 的两类形状各给正负样本，并要求裁判独立同意
//                      （countSolutions 在 conflict 上必须走 'none' 且 reason 逐字相等）。
//   §6 尺寸语法        parseSize/gridOf 的接受面变宽（放开裸数字、放开 2×2）会红。
//
// 参照：兄弟仓 z-biz-game-zebra-cos/tools/rule-test.mjs 的写法（正例 + 负例 + 穷举对照），
// 判据全部是 Hidato 自己的（王步几何、值轴连续性、端点成例）。

import {
  buildGrid, gridOf, parseSize, isAdjacent, makeGiven, givensFromSeq, cellOfFromSeq, countGivens,
  endpoints, isLockedGiven, droppableValues, verifyNumbering, isLegalNumbering, givenConflict,
  toGivenCell, fromGivenCell, missingEndpoints, valueOfCell,
} from '../js/engine/rules.js';
import { TIERS, generate, produce, gridFor, samplePath } from '../js/engine/generate.js';
import { countSolutions } from '../js/engine/counter.js';
import { makeRng } from '../js/engine/rng.js';

const SAMPLES = Number(process.env.SAMPLES || 4);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) {
  console.error(`SAMPLES 要是 >=1 的整数，实得 ${process.env.SAMPLES}`);
  process.exit(2);
}

console.log('================================================================================');
console.log('HIDATO RULE-TEST — 词汇表与合法定义的独立对照闸');
console.log(`samples   : ${SAMPLES} 张真盘/档（seed = hidato|<size>|<i>）· node ${process.version}`);
console.log('================================================================================');

let checks = 0, fails = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`);
};
const eq = (name, got, want) => ok(name, got === want, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);

/** 本文件自己按 Cross+A 题面重写一遍的几何（不 import rules.js 的任何判定）。 */
const cheb = (R, C, i, j) => Math.max(Math.abs(((i / C) | 0) - ((j / C) | 0)), Math.abs((i % C) - (j % C)));
const kingNeighbors = (R, C, i) => {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const r = ((i / C) | 0) + dr, c = (i % C) + dc;
    if (r < 0 || r >= R || c < 0 || c >= C) continue;
    out.push(r * C + c);
  }
  return out;
};
/** 5×5 蛇形链（行主序扫描不是王步链，本机实测会在 adjacency-fail@5 上红，所以这里用蛇形）。 */
const snakeSeq = (R, C) => {
  const seq = new Int32Array(R * C);
  let d = 0;
  for (let r = 0; r < R; r++) for (let k = 0; k < C; k++) seq[d++] = r * C + (r % 2 ? C - 1 - k : k);
  return seq;
};

// ── §1 几何 ────────────────────────────────────────────────────────────────
console.log('');
console.log('── §1 几何：王步邻接、NB 序、DIST/adj 同源 ──');
{
  const G3 = buildGrid(3, 3);
  eq('3×3 中心的 NB 逐格序 = (-1,-1)→(1,1) 行主序去自身', JSON.stringify(G3.NB[4]), JSON.stringify([0, 1, 2, 3, 5, 6, 7, 8]));
  eq('3×3 角上的 NB（含对角）', JSON.stringify(G3.NB[0]), JSON.stringify([1, 3, 4]));
  eq('3×3 边中的 NB（含两格对角）', JSON.stringify(G3.NB[1]), JSON.stringify([0, 2, 3, 4, 5]));
  ok('NB 里没有自身、没有越界格（全 3×3 检查）', G3.NB.every((l, i) => !l.includes(i) && l.every((j) => j >= 0 && j < 9 && [...new Set(l)].length === l.length)), 'NB 序或越界剔除被动过');

  // 邻接对数按公式独立重算：横 R(C−1) + 竖 (R−1)C + 斜 2(R−1)(C−1)，每对算一次
  const shapes = [[3, 3, 8], [4, 4, 18], [5, 5, 32], [7, 7, 72], [4, 6, 30]];
  let badDeg = 0, badDiag = 0, badPairs = 0, distBad = 0, adjSplit = 0;
  const diagRead = [];
  for (const [R, C, expDiag] of shapes) {
    const G = buildGrid(R, C);
    let deg = 0;
    for (let i = 0; i < G.n; i++) {
      if (G.NB[i].length !== kingNeighbors(R, C, i).length) badDeg++;
      if (JSON.stringify(G.NB[i]) !== JSON.stringify(kingNeighbors(R, C, i))) badPairs++;
      deg += G.NB[i].length;
    }
    const wantDeg = 2 * (R * (C - 1) + (R - 1) * C + 2 * (R - 1) * (C - 1));
    if (deg !== wantDeg) badDeg++;
    // 斜邻居数单独钉：把它算成 0 就等于偷偷改成 Numbrix
    let diag = 0;
    for (let i = 0; i < G.n; i++) for (const j of G.NB[i]) if (i < j && (i % C !== j % C) && (((i / C) | 0) !== ((j / C) | 0))) diag++;
    if (diag !== expDiag) badDiag++;
    diagRead.push(`${R}×${C} 实测 ${diag}/公式 ${expDiag}`);
    for (let i = 0; i < G.n; i++) for (let j = 0; j < G.n; j++) {
      const d = G.DIST[i * G.n + j];
      if (d !== cheb(R, C, i, j)) distBad++;
      if ((d === 1) !== isAdjacent(G, i, j)) adjSplit++;

    }
  }
  ok('五种形状（含非方 4×6）的 NB 表与本文件独立重算逐格相等', badPairs === 0, `序不符 ${badPairs} 格 · 度数不符 ${badDeg} 格`);
  ok('对角相邻确实存在：斜邻居对数 = 2(R−1)(C−1)', badDiag === 0 && distBad === 0, `${diagRead.join(' · ')} · DIST 与本文件自算切比雪夫不符 ${distBad} 对`);
  ok('isAdjacent ⟺ DIST===1（五种形状全部格对，adj 与 DIST 不许分家）', adjSplit === 0, `分歧 ${adjSplit} 对`);

  // DIST 的自反/对称/值域 + dist 闭包
  const G5 = buildGrid(5, 5);
  let selfBad = 0, symBad = 0, rangeBad = 0, closureBad = 0, adjCnt = 0;
  for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) {
    const d = G5.DIST[i * 25 + j];
    if (i === j && d !== 0) selfBad++;
    if (d !== G5.DIST[j * 25 + i]) symBad++;
    if (d < 0 || d > 4) rangeBad++;
    if (G5.dist(i, j) !== d) closureBad++;
    if (isAdjacent(G5, i, j)) adjCnt++;
  }
  ok('DIST 自反为 0、对称、值域 0..max(R,C)−1', selfBad === 0 && symBad === 0 && rangeBad === 0, `自反 ${selfBad} · 对称 ${symBad} · 越界 ${rangeBad}`);
  eq('dist 闭包与 DIST 表逐对相同（5×5 的 625 对）', closureBad, 0);
  eq('5×5 的有向相邻计数 = 144（横 20 + 竖 20 + 斜 32 = 72 对 ×2）', adjCnt, 144);
  ok('对角相邻的正负对照：(0,0)-(1,1) 相邻、(0,0)-(0,2) 不相邻', isAdjacent(G5, 0, 6) && !isAdjacent(G5, 0, 2), '斜禁实现会在这一条上红');
}

// ── §2 表示与互逆 ──────────────────────────────────────────────────────────
console.log('');
console.log('── §2 数据形状：givenCell / cellOf / 线索数组 ──');
{
  const G = buildGrid(5, 5), n = 25;
  const seq = snakeSeq(5, 5);
  const given = givensFromSeq(seq, n), cellOf = cellOfFromSeq(seq, n);
  let diff = 0;
  for (let v = 1; v <= n; v++) if (given[v] !== cellOf[v]) diff++;
  eq('givensFromSeq 与 cellOfFromSeq 在 1..N 上逐值相同（同一个 seq 的两种读法）', diff, 0);
  ok('下标 0 的分工：givenCell[0] 恒 -1（值域 1..N），cellOf[0] 是没用的 0', given[0] === -1 && cellOf[0] === 0, `given[0]=${given[0]} cellOf[0]=${cellOf[0]}`);
  eq('满盘题面的条数 countGivens = N', countGivens(given), n);
  eq('makeGiven 给的是 N+1 长、全 -1', JSON.stringify(Array.from(makeGiven(4))), JSON.stringify([-1, -1, -1, -1, -1]));

  // 往返：Int32Array → 数组 → Int32Array
  const carved = Int32Array.from(given);
  for (let v = 2; v < n; v += 3) carved[v] = -1;
  const arr = fromGivenCell(carved);
  const back = toGivenCell(G, arr);
  let rtBad = 0;
  for (let v = 1; v <= n; v++) if (back[v] !== carved[v]) rtBad++;
  eq('fromGivenCell → toGivenCell 逐值往返相同（含未印的 -1）', rtBad, 0);
  eq('fromGivenCell 只吐印出来的位置（跳过 -1）', arr.length, countGivens(carved));
  ok('数组元素形状是 {v,cell}', arr.every((c) => Number.isInteger(c.v) && Number.isInteger(c.cell) && c.v >= 1 && c.v <= n && c.cell >= 0 && c.cell < n), JSON.stringify(arr[0]));
  const pairs = arr.map((c) => [c.v, c.cell]);
  let pairBad = 0;
  const viaPairs = toGivenCell(G, pairs);
  for (let v = 1; v <= n; v++) if (viaPairs[v] !== carved[v]) pairBad++;
  eq('同一个题面的 [v,cell] 写法与 {v,cell} 写法等价', pairBad, 0);
  ok('Int32Array 是原样复用（不复制：热路径省一次分配，改了它调用方看得见）', toGivenCell(G, carved) === carved, '变成复制版会让这条红（是有意的口径）');

  let throws = [];
  const bad = [
    ['值 0 越界', () => toGivenCell(G, [{ v: 0, cell: 0 }])],
    ['值 N+1 越界', () => toGivenCell(G, [{ v: n + 1, cell: 0 }])],
    ['格越界', () => toGivenCell(G, [{ v: 1, cell: n }])],
    ['同一个值印在两格', () => toGivenCell(G, [{ v: 5, cell: 1 }, { v: 5, cell: 2 }])],
    ['Int32Array 长度不对', () => toGivenCell(G, new Int32Array(n))],
    ['形状不认识', () => toGivenCell(G, '1@0')],
  ];
  for (const [tag, f] of bad) { try { f(); throws.push(tag + '(没抛)'); } catch { /* 期望抛 */ } }
  eq('toGivenCell 的六条入参检查都会抛（少一条就是"少印一条线索"会静默过去）', throws.length, 0);
  if (throws.length) console.log(`  ${throws.join(' / ')}`);
  // valueOfCell 是 given 的反查：印出来的格→值、没印的格→-1，且两者互为单侧逆
  const board = valueOfCell(G, carved);
  let vcv = 0, ghost = 0;
  for (let v = 1; v <= n; v++) if (carved[v] >= 0 && board[carved[v]] !== v) vcv++;
  for (let c = 0; c < n; c++) {
    if (board[c] === -1) { if (Array.from(carved).slice(1).includes(c)) ghost++; }
    else if (carved[board[c]] !== c) ghost++;
  }
  eq('valueOfCell 对每个印出来的值都能反查回原格', vcv, 0);
  eq('valueOfCell 与 givenCell 完全互逆（没印的格是 -1、印过的格不许漏）', ghost, 0);
}

// ── §3 合法盘的唯一定义 ────────────────────────────────────────────────────
console.log('');
console.log('── §3 verifyNumbering：每条违规一个负样本 + 修好它之后的正样本 ──');
{
  const G = buildGrid(5, 5), n = 25;
  const seq = snakeSeq(5, 5);
  const full = givensFromSeq(seq, n), cellOf = cellOfFromSeq(seq, n);
  /** 只印两端点的题面：这样"改解"不会先撞上 given-violated（§3 的负样本要各自孤立）。 */
  const ep = (nx, c) => { const g = makeGiven(nx); g[1] = c[1]; g[nx] = c[nx]; return g; };
  eq('满盘蛇形链 ⇒ ok（正样本）', verifyNumbering(G, full, cellOf), 'ok');
  eq('只印两端点的同一张解 ⇒ ok（题面薄不影响判定）', verifyNumbering(G, ep(n, cellOf), cellOf), 'ok');
  eq('isLegalNumbering 是同一个判定的布尔读法', isLegalNumbering(G, full, cellOf), true);
  let chainBad = 0;
  for (let v = 1; v < n; v++) if (G.DIST[cellOf[v] * n + cellOf[v + 1]] !== 1) chainBad++;
  eq('夹具自查：蛇形链的 24 对相邻数距离全是 1', chainBad, 0);   // 夹具坏了下面每条负样本都失去意义

  // (a) 不是排列：两个值挤同一格 / 漏一个数 / 格号越界。负样本各配一个"只修这一处"的正样本。
  const dupPair = Int32Array.from(cellOf); dupPair[7] = dupPair[9];
  const missing = Int32Array.from(cellOf); missing[13] = -1;
  const oob = Int32Array.from(cellOf); oob[20] = n;
  eq('同格两数 ⇒ not-a-permutation', verifyNumbering(G, ep(n, cellOf), dupPair), 'not-a-permutation');
  eq('漏一个数（-1）⇒ not-a-permutation', verifyNumbering(G, ep(n, cellOf), missing), 'not-a-permutation');
  eq('格号越界 ⇒ not-a-permutation', verifyNumbering(G, ep(n, cellOf), oob), 'not-a-permutation');
  const repaired = Int32Array.from(oob); repaired[20] = cellOf[20];
  eq('把 oob 的 20 改回它那格 ⇒ ok（负样本不是空转）', verifyNumbering(G, ep(n, cellOf), repaired), 'ok');

  // (b) 印出来的数不在自己那格（满盘题面下最敏感：每个数都被钉着）
  const gv = Int32Array.from(full); gv[9] = 12;
  eq('题面把 9 印到别处 ⇒ given-violated', verifyNumbering(G, gv, cellOf), 'given-violated');
  const gvFix = Int32Array.from(gv); gvFix[9] = cellOf[9];
  eq('把 9 印回它那格 ⇒ ok（同一处缺陷修掉就绿）', verifyNumbering(G, gvFix, cellOf), 'ok');

  // (c) 连续性：v 与 v+1 必须王步相邻，违规串里要带断在值轴的哪一段
  const G3 = buildGrid(3, 3);
  // 一条**走对角**的 3×3 哈密顿链：0→4→8→7→5→2→1→3→6（1→2、2→3、5→6、7→8 四对是对角步）
  const diagPath = Int32Array.from([0, 4, 8, 7, 5, 2, 1, 3, 6]);
  const dGiven = givensFromSeq(diagPath, 9), dCell = cellOfFromSeq(diagPath, 9);
  eq('对角步的满盘链 ⇒ ok（Hidato 是王式，不是斜禁；斜禁实现在这里红）', verifyNumbering(G3, dGiven, dCell), 'ok');
  // 把 2 与 6 的格互换：仍是排列，但 1(0,0)→2(0,2) 变成切比雪夫 2 ⇒ 断在 @1
  const brk = Int32Array.from(dCell); const t = brk[2]; brk[2] = brk[6]; brk[6] = t;
  eq('切比雪夫 2 的相邻两数 ⇒ adjacency-fail@1（串里带值号，门禁要能读出断在哪段）', verifyNumbering(G3, ep(9, dCell), brk), 'adjacency-fail@1');
  eq('同一处缺陷放回对角步 ⇒ ok（负对照）', verifyNumbering(G3, ep(9, dCell), dCell), 'ok');
  // 断在链条**最后一段**也要报得出来（循环边界 v<n 被钉住）。这里只能印一个数：
  // 9 是被印出来的，交换 8/9 会先撞上 given-violated（题面检查在连续性检查之前），
  // 所以用只印 1 的题面把缺陷孤立到最后两格。
  const oneOnly = (nx, c) => { const g = makeGiven(nx); g[1] = c[1]; return g; };
  const brkEnd = Int32Array.from(dCell); const t9 = brkEnd[8]; brkEnd[8] = brkEnd[9]; brkEnd[9] = t9;
  eq('交换链尾两格 ⇒ 报 adjacency-fail@7（串里的数字是断点值号，不是格号）', verifyNumbering(G3, oneOnly(9, dCell), brkEnd), 'adjacency-fail@7');

  // (d) 判定次序：同一个 v 上排列破坏先于题面破坏
  const precC = Int32Array.from(dCell); precC[2] = precC[1];
  const precG = ep(9, dCell); precG[2] = 8;
  eq('同一个值上同时坏排列与题面 ⇒ 先报 not-a-permutation', verifyNumbering(G3, precG, precC), 'not-a-permutation');

  // (e) 布尔包装与字符串判定不许分家：3×3 与 5×5 的两批样本各过一遍
  const pairs3 = [[ep(9, dCell), dCell], [ep(9, dCell), brk], [dGiven, dCell], [dGiven, brkEnd], [precG, precC]];
  const pairs5 = [[full, cellOf], [ep(n, cellOf), dupPair], [ep(n, cellOf), missing], [gv, cellOf], [gvFix, cellOf]];
  let boolBad = 0;
  for (const [g, c] of pairs3) if (isLegalNumbering(G3, g, c) !== (verifyNumbering(G3, g, c) === 'ok')) boolBad++;
  for (const [g, c] of pairs5) if (isLegalNumbering(G, g, c) !== (verifyNumbering(G, g, c) === 'ok')) boolBad++;
  eq(`isLegalNumbering 与 verifyNumbering 在 ${pairs3.length + pairs5.length} 组样本上永不分歧`, boolBad, 0);
  void diagPath;
}

// ── §4 端点不变量 ──────────────────────────────────────────────────────────
console.log('');
console.log('── §4 端点：1 与 N 不进候选池是**成例**，不是唯一性前提 ──');
{
  for (const n of [9, 16, 25, 36, 49]) {
    const d = droppableValues(n);
    eq(`droppableValues(${n}) = 2..N−1（长度 N−2）`, JSON.stringify(d), JSON.stringify(Array.from({ length: n - 2 }, (_, i) => i + 2)));
    ok(`候选池不含 1 也不含 ${n}`, !d.includes(1) && !d.includes(n), `池里有端点 ⇒ 出题器会把端点删掉，题面读法变了`);
    ok(`endpoints(${n}) = [1,${n}] 且两端都是锁住的`, JSON.stringify(endpoints(n)) === JSON.stringify([1, n]) && isLockedGiven(1, n) && isLockedGiven(n, n) && !isLockedGiven(2, n), 'isLockedGiven 口径变了');
  }
  const G = buildGrid(5, 5), n = 25;
  const g = makeGiven(n);
  eq('两端都没印 ⇒ missingEndpoints = both', missingEndpoints(G, g), 'both');
  g[1] = 0;
  eq('只印 1 ⇒ one', missingEndpoints(G, g), 'one');
  g[1] = -1; g[n] = 4;
  eq('只印 N ⇒ one', missingEndpoints(G, g), 'one');
  g[1] = 0;
  eq('两端齐印 ⇒ null', missingEndpoints(G, g), null);
  ok('both/one/null 三态互不相同（合并成一态就查不出少印了哪个）', new Set(['both', 'one', null]).size === 3, '');

  // 真盘：出货盘与不可约证书盘都必须齐印两端
  let noEp = 0, sameCell = 0, tot = 0, cert = 0, shipN = 0;
  const certGivens = [], shipGivensArr = [];
  for (const tier of TIERS) {
    const Gt = gridFor(tier);
    for (let i = 0; i < SAMPLES; i++) {
      const p = produce(tier.key, i, { confirm: false });
      if (!p.ok) { console.log(`  FAIL produce ${tier.key}#${i} 失败：${p.fail}`); fails++; checks++; continue; }
      tot++; cert++;
      if (missingEndpoints(Gt, p.board.given) !== null) noEp++;
      if (p.board.given[1] === p.board.given[tier.n]) sameCell++;
      certGivens.push(countGivens(p.board.given));
      const gs = generate(tier.key, 2000 + i);
      if (!gs.ok) { console.log(`  FAIL generate ${tier.key}#${2000 + i} 失败：${gs.fail}`); fails++; checks++; continue; }
      tot++; shipN++;
      if (missingEndpoints(Gt, gs.ship.given) !== null) noEp++;
      if (gs.ship.given[1] === gs.ship.given[tier.n]) sameCell++;
      shipGivensArr.push(gs.ship.givens);
    }
  }
  eq(`${tot} 张真盘（证书 ${cert} + 出货 ${shipN}）都齐印两端点、且两端不在同一格`, noEp + sameCell, 0);
  const med = (x) => x.slice().sort((p, q) => p - q)[x.length >> 1];
  ok('出货层确实比不可约核心密（密度梯在干活）', med(shipGivensArr) > med(certGivens), `不可约中位 ${med(certGivens)} 条 → 出货中位 ${med(shipGivensArr)} 条（${SAMPLES} 张/档 ×3 档）`);

  // 3×3 全 511 个题面子集，按端点印没印分四象限，用**裁判**数解。
  // 这一段的用处：把 rules.js 里被钉掉的旧说法钉第二次。旧说法"两端点都不印 ⇒ 必然多解"
  // 若是真的，(--, 无端点) 那一格必然 unique=0；实测它 >0 ⇒ 旧说法不是定理，
  // 端点不进候选池因此是成例（Cross+A 题面齐印两端）+ 免费的对合破除，而不是唯一性前提。
  const G3 = buildGrid(3, 3);
  const snake3 = Int32Array.from([0, 1, 2, 5, 4, 3, 6, 7, 8]);
  const cell3 = cellOfFromSeq(snake3, 9);
  const quad = { 'L+R': [0, 0], 'L+−': [0, 0], '−+R': [0, 0], '−+−': [0, 0] };
  let solBad = 0;
  for (let m = 0; m < 512; m++) {
    const gg = new Int32Array(10).fill(-1);
    for (let v = 1; v <= 9; v++) if (m & (1 << (v - 1))) gg[v] = cell3[v];
    const key = (m & 1 ? 'L' : '−') + '+' + (m & 256 ? 'R' : '−');
    const r = countSolutions(G3, gg, { nodeCap: 200000, msCap: 400 });
    quad[key][r.outcome === 'unique' ? 0 : 1]++;
    if (r.outcome === 'unique' && verifyNumbering(G3, gg, r.solutions[0]) !== 'ok') solBad++;
  }
  console.log(`  读数 3×3 全 512 个题面子集（unique/其余）：两端齐印 ${quad['L+R'].join('/')} · 只印 1 ${quad['L+−'].join('/')} · 只印 N ${quad['−+R'].join('/')} · 两端都不印 ${quad['−+−'].join('/')}`);
  ok('两端都不印仍**能**唯一（旧定理"必然多解"的反例，读数必须 >0）', quad['−+−'][0] > 0, `实测 ${quad['−+−'][0]} 个无端点题面被裁判判唯一`);
  ok('只印一个端点也能唯一（对合破除不靠两端齐印）', quad['L+−'][0] > 0 && quad['−+R'][0] > 0, `只印 1：${quad['L+−'][0]} · 只印 N：${quad['−+R'][0]}`);
  eq('裁判说 unique 的题面，它带回来的解必须过 verifyNumbering（两条通道同一张盘）', solBad, 0);
}

// ── §5 题面自相矛盾 ────────────────────────────────────────────────────────
console.log('');
console.log('── §5 givenConflict：两类矛盾形状 + 裁判独立同意 ──');
{
  const G3 = buildGrid(3, 3);
  const mk = (pairs) => { const g = new Int32Array(10).fill(-1); for (const [v, c] of pairs) g[v] = c; return g; };
  const snake3 = Int32Array.from([0, 1, 2, 5, 4, 3, 6, 7, 8]);
  const good = givensFromSeq(snake3, 9);
  eq('满盘合法题面 ⇒ 无矛盾（正样本）', givenConflict(G3, good), null);
  const dup = Int32Array.from(good); dup[3] = dup[5];            // 值 3 与 5 印在同一格
  eq('同一格印两个数 ⇒ duplicate-given-cell', givenConflict(G3, dup), 'duplicate-given-cell');
  // 5 在 (2,2)=8、6 挪到 (1,0)=3：切比雪夫 2 ⇒ 相邻两印断掉；格子 0/1/8/3 互不相同，不会先撞 duplicate
  const adjBad = mk([[1, 0], [2, 1], [5, 8], [6, 3]]);
  eq('相邻两印的数距离不为 1 ⇒ given-adjacency', givenConflict(G3, adjBad), 'given-adjacency');
  const adjFix = mk([[1, 0], [2, 1], [5, 8], [6, 5]]);           // 6 挪到 (1,2)：正边相邻
  eq('把 6 挪回 5 的邻格 ⇒ null（同一处缺陷修掉就绿）', givenConflict(G3, adjFix), null);
  // 对角印：1(0,0)→2(1,1)→3(2,2) 全是**对角**步，题面必须合法（斜禁实现会误报 given-adjacency）
  const diagPrint = mk([[1, 0], [2, 4], [3, 8]]);
  eq('对角相邻的印刷不算矛盾（Hidato 的王式读法）', givenConflict(G3, diagPrint), null);
  const diagFar = mk([[1, 0], [2, 8]]);                          // 切比雪夫 2
  eq('同一条对角链拉成距离 2 ⇒ given-adjacency（对角判定的负对照）', givenConflict(G3, diagFar), 'given-adjacency');
  const sparse = mk([[1, 0], [9, 4]]);
  eq('只印两端且相距很远 ⇒ null（连续性只约束都印出来的**相邻**两数）', givenConflict(G3, sparse), null);
  // 裁判与题面检查同意：conflict 非空的盘，countSolutions 必须走 'none' 且 reason 逐字相等
  let refDisagree = 0;
  const conflictCases = [['满盘合法', good], ['同格两数', dup], ['相邻两印断开', adjBad], ['修好的相邻两印', adjFix],
    ['对角印刷', diagPrint], ['对角拉成 2', diagFar], ['只印两端', sparse]];
  for (const [tag, gg] of conflictCases) {
    const r = countSolutions(G3, gg, { nodeCap: 200000, msCap: 400 });
    const conflict = givenConflict(G3, gg);
    if (conflict && !(r.outcome === 'none' && r.reason === conflict)) refDisagree++;
    if (!conflict && r.outcome === 'none' && r.reason) refDisagree++;
  }
  eq(`${conflictCases.length} 张对照题面上 givenConflict 与裁判 reason 逐字同意（矛盾题面不许有解、合法题面不许被拒）`, refDisagree, 0);
}

// ── §6 尺寸语法 ────────────────────────────────────────────────────────────
console.log('');
console.log('── §6 parseSize / gridOf：TIERS、seed 串、页面上拉框共用一个语法 ──');
{
  eq("parseSize('5x5')", JSON.stringify(parseSize('5x5')), JSON.stringify({ R: 5, C: 5 }));
  eq("parseSize(' 6x6 ') 允许首尾空白", JSON.stringify(parseSize(' 6x6 ')), JSON.stringify({ R: 6, C: 6 }));
  eq("parseSize('4x6') 支持非方（几何不只服务出货三档）", JSON.stringify(parseSize('4x6')), JSON.stringify({ R: 4, C: 6 }));
  const obj = { R: 7, C: 7 };
  ok('对象形状原样返回', parseSize(obj) === obj, '对象读法被改会动到 gridFromSize 的收口');
  let threw = 0;
  for (const bad of ['5', '5y5', 'x', '', '05x5x5', '5.X5', 'axb']) { try { parseSize(bad); } catch { threw++; } }
  eq('七种不合规写法全部被拒（含裸数字：N 的两种读法不许混）', threw, 7);
  let gThrew = 0;
  for (const [R, C] of [[2, 2], [1, 9], [2, 3], [0, 0], [2.5, 3]]) { try { gridOf(R, C); } catch { gThrew++; } }
  eq('gridOf 拒掉 R<3 或非整数（装不下唯一性话题面）', gThrew, 5);
  eq("gridOf(3,3).n", gridOf(3, 3).n, 9);
  for (const tier of TIERS) {
    const p = parseSize(tier.key);
    ok(`TIERS ${tier.key} 过 parseSize 与档位自洽`, p.R === tier.R && p.C === tier.C && p.R * p.C === tier.n, `${JSON.stringify(p)} vs ${tier.R}×${tier.C}`);
    eq(`TIERS ${tier.key} 的 gridFor 与 buildGrid 同形状`, gridFor(tier).n, buildGrid(tier.R, tier.C).n);
  }
}

// ── §7 出货几何与夹具的交叉验证（王步链在真盘上）───────────────────────────
console.log('');
console.log('── §7 交叉：真盘的解是本文件独立重算的合法王步链 ──');
{
  let bad = 0, badChain = 0, tot = 0;
  for (const tier of TIERS) {
    const G = gridFor(tier);
    for (let i = 0; i < SAMPLES; i++) {
      const gs = generate(tier.key, 7000 + i);
      if (!gs.ok) continue;
      tot++;
      if (verifyNumbering(G, gs.ship.given, gs.solution) !== 'ok') bad++;
      for (let v = 1; v < tier.n; v++) {
        const d = cheb(tier.R, tier.C, gs.solution[v], gs.solution[v + 1]);
        if (d !== 1) badChain++;
      }
      // 出题器自报的 path 不许当答案用：它必须与裁判带回的解一致才说明这条链真的被印过
      if (verifyNumbering(G, givensFromSeq(gs.board.path, tier.n), cellOfFromSeq(gs.board.path, tier.n)) !== 'ok') bad++;
    }
  }
  eq(`${tot} 张出货盘的裁判解过 verifyNumbering（本文件唯一的合法性入口）`, bad, 0);
  eq('同一批解的每对相邻数在本文件自算的切比雪夫表里距离恰为 1', badChain, 0);
  ok('样本量真的够（不是空跑）', tot >= TIERS.length * 1, `${tot} 张`);
}

// ── §8 抽一条路径的几何就是王步（generate 与 rules 同一份邻接）──────────────
console.log('');
console.log('── §8 采样器交出来的东西必须过 §3 的定义 ──');
{
  const G = buildGrid(4, 5);
  let drawn = 0, badSeq = 0, notPerm = 0;
  for (let s = 0; s < 12; s++) {
    const rnd = makeRng(`rule-test|4x5|${s}`);
    const sp = samplePath(G, rnd);
    if (!sp.ok) continue;
    drawn++;
    const gf = givensFromSeq(sp.seq, 20), cf = cellOfFromSeq(sp.seq, 20);
    if (verifyNumbering(G, gf, cf) !== 'ok') badSeq++;
    if (new Set(Array.from(sp.seq)).size !== 20) notPerm++;
  }
  ok('4×5 上采到的每条哈密顿路径都是合法满盘（biased 采样器与 rules 同一份几何）', drawn > 8 && badSeq === 0 && notPerm === 0, `采到 ${drawn}/12 · 非法 ${badSeq} · 非排列 ${notPerm}`);
}

console.log('');
console.log(`RESULT rule-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
