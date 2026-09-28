#!/usr/bin/env node
// 一次性端口对账（throwaway）：js/engine 那条流水线吃屏的 seed 串，必须吐回屏量出来的指纹。
// 参照物 = 工作区根的 _tmp-hidato-boards.tsv（120 行，第 3 列 seed、第 36 列 fingerprint，
// 由 _tmp-hidato-screen.mjs 在 2026-09-28、loadavg 5.99→6.37 那一次跑出）。
// 指纹逐字节对，不对分布：条数相同不等于同一张盘。
// 跑：node z-biz-game-hidato-cos/tools/port-check.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { gridFor, tierOf, produceBoard, fingerprint, solutionCellOf } from '../js/engine/generate.js';
import { verifyNumbering } from '../js/engine/rules.js';
import { countWitnessB } from '../js/engine/witness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = resolve(HERE, '../../_tmp-hidato-boards.tsv');
// 参照物是**选型屏**的输出，不在本仓里（屏本身是一次性的选型证据，不是产品代码）。
// 缺了就明确说"这一步在本仓之外"，别让它读起来像引擎坏了 —— CI 不跑这个工具。
let raw;
try { raw = readFileSync(REF, 'utf8'); }
catch { console.error(`port-check 跳过：参照物 ${REF} 不在（它是 2026-09-28 选型屏的输出，不属于本仓）。`); process.exit(3); }
const rows = raw.trim().split('\n').slice(1).map((l) => l.split('\t'));

const loadavg = () => { try { return execSync('sysctl -n vm.loadavg').toString().trim(); } catch { return 'n/a'; } };
console.log(`port-check  refs=${REF}  rows=${rows.length}  loadavg=${loadavg()}  node=${process.version}`);
console.log(`config      TIERS: ${['5x5', '6x6', '7x7'].map((k) => { const t = tierOf(k); return `${t.key} budgetMs=${t.budgetMs} nodeCap=${t.nodeCap} carve=${t.carve.nodeCap}/${t.carve.msCap}ms band=[${t.band}]`; }).join(' · ')}`);

let hit = 0, badSolution = 0, witMismatch = 0, treeSame = 0;
const treeMiss = [];
const refTally = {};
const miss = [];
const perSize = {};
const t0 = performance.now();
for (const r of rows) {
  const size = r[0], i = Number(r[1]), seed = r[2], givensRef = Number(r[3]), refOut = r[5], fpCol = r[35];
  const tier = tierOf(size);
  const G = gridFor(tier);
  const b = produceBoard(G, seed, {
    nodeCap: tier.nodeCap, msCap: tier.budgetMs,
    carveNodeCap: tier.carve.nodeCap, carveMsCap: tier.carve.msCap,
  });
  const got = b.fail ? 'FAIL:' + b.fail : fingerprint(G, b.given, solutionCellOf(b));
  const s = perSize[size] || (perSize[size] = { n: 0, hit: 0, givens: [] });
  s.n++;
  if (got === fpCol) { hit++; s.hit++; } else miss.push({ size, i, seed, expect: fpCol, got, refOut, mine: b.ref.outcome, givensRef, givensMine: b.survivors.length });
  if (!b.fail) {
    s.givens.push(b.survivors.length);
    // 比指纹更强的一层：裁判的**搜索树本身**逐行对照屏的第 5/8/9/10/11 列（最长 gap、节点数、
    // ≥2 选项的分支点数、死路数、零分支证人）。这五个数都是纯函数（不含 ms 闸的路径），
    // 它们逐行相同 ⇒ 不是"碰巧给出同一个答案"，而是同一棵树 —— 剪枝次序一处漂动就对不上。
    const mineT = [b.ref.maxGap, b.ref.nodes, b.ref.multiWay, b.ref.deadEnds, b.ref.zeroBranch ? 1 : 0];
    const refT = [Number(r[4]), Number(r[7]), Number(r[8]), Number(r[9]), Number(r[10])];
    if (mineT.join(',') === refT.join(',')) treeSame++;
    else treeMiss.push(`${size}#${r[1]} ref ${refT.join('/')} mine ${mineT.join('/')}`);
    refTally[size + ' ' + b.ref.outcome] = (refTally[size + ' ' + b.ref.outcome] || 0) + 1;
    const sol = b.ref.solutions[0];
    if (sol && verifyNumbering(G, b.given, sol) !== 'ok') badSolution++;
    const w = countWitnessB(G, b.given, {});
    if (w.outcome !== 'stopped' && w.outcome !== b.ref.outcome) witMismatch++;
  }
}
console.log(`wall        ${Math.round(performance.now() - t0)} ms for ${rows.length} boards`);
for (const k of Object.keys(perSize)) {
  const s = perSize[k];
  const mean = s.givens.reduce((a, x) => a + x, 0) / (s.givens.length || 1);
  console.log(`size        ${k}: fingerprints ${s.hit}/${s.n} · 不可约线索均值 ${mean.toFixed(2)} 条`);
}
console.log(`side checks : 出货裁判读数 ${JSON.stringify(refTally)} · 裁判解过独立合法性谓词失败 ${badSolution} · 见证 B 与裁判不一致（stopped 不算）${witMismatch}`);
console.log(`fingerprints ${hit}/${rows.length}`);
console.log(`referee tree ${treeSame}/${rows.length} (逐行对照 gap/nodes/multiWay/deadEnds/zeroBranch)`);
for (const m of miss) {
  console.log(`MISS ${m.size}#${m.i} seed=${m.seed} expect=${m.expect} got=${m.got} referee=${m.refOut}/${m.mine} givens=${m.givensRef}/${m.givensMine}`);
}
for (const m of treeMiss) console.log(`TREE-MISS ${m}`);
// 故意不设退出码：这是一张对账单，不是一道闸（闸属于阶段二，且只认"变强"不认"变宽"）。
