#!/usr/bin/env node
// 出货平衡闸 · 每档若干张真出货盘，把三条产品承诺各自钉成红线
//
// 跑：            node tools/balance.mjs                 （SAMPLES=12）
//               SAMPLES=60 node tools/balance.mjs      （回填 TIERS 用的一次性大样本）
// CI 用 SAMPLES=24（工作流在第二阶段接入；本阶段仓库里还没有 .github/workflows/，别照抄 zebra 那份）。
//
// 这个闸量的是**生产路径**：generate() 里真实发生的每一次裁判调用（挖线索探针 + 不可约证书 +
// 出货层），第 3 步的 QA 复核（kind='confirm'）单独记账、不进定价池 —— 把 QA 的成本算进出货
// 预算会把表定贵，反过来把 QA 读当成出货读数会把红线定松。
//
// 定价公式（本组织口径，取尾巴不取中位×2，因为出题墙钟双峰）：
//   通用式   band = [max(1, floor(中位 × 0.4)), max(lo + 1, ceil(p95 × 1.6))]
//   budgetMs = max(10, ceil(生产路径裁判 p95 × 4 / 10) × 10)
// 两个被测量按档位写成 TIERS 里的 band / ladder / attempts / budgetMs，含义分别是：
//   band    = 每盘**生产路径裁判调用次数**（挖线索探针 + 证书 + 出货，不含 QA 复核）
//   ladder  = 出货要沿密度梯走几层
//   attempts= 每盘抽哈密顿路径的次数（receipt.draws）
// 本品类有个例外要讲清：band 这一量在这里是**恒等式**而不是分布 —— 每盘恰好
// (n−2) 次探针 + 1 次证书 + 1 次出货 = n 次（三档 12 张盘实测 min=max=n，2026-09-29），
// 所以 TIERS.band 写死 [n, n]，不套通用式。套式子会得到 [10, 40] 这种带 0.4×/1.6× 余量的区间，
// 那是给一个纯结构常数凭空留 60% 的漂移口子：管线真的多打一次裁判调用时闸不会响。
// ladder 反过来要留上界余量（层数随盘变，且**变小不是回归**），所以下界写 1、上界用 p95×1.6；
// 下界若也套 0.4×中位，会把实测最小层数砍在表外，SAMPLES 一改就一绿一红（本组织栽过一次）。
// 两个数都必须**纯函数**才能当闸：裁判调用次数、密度梯层数、每盘抽取次数都不看时钟。
// 毫秒只用来验"ms 闸没参与判定"（G2：归因到 msCap 的击穿数 = 0），不在闸里断言"应该多快"。
//
// 红线（每条都是"变强"，不是"变宽"）：
//   A 出货唯一性      每张出货盘的裁判都必须 provesUnique（stopped/multiple/none 一律算红）
//   B 答案独立合法    裁判带回的那张解过 rules.verifyNumbering，0 失败
//   C 零猜测承诺      出货盘**从题面重跑** BASIC 铅笔必须推得完（不靠梯子内部自报的 solved）
//   D 独立见证一致    见证 B 与裁判同读数；MISMATCH 必须 0，stopped 记"无读数"不算分歧
//   E 不可约证书      假证书（幸存线索被证明删得掉）必须 0；"只因探针预算没证完而留"那条必须
//                     逐档归因得回一次 carve 击穿，归不上就红
//   F 铅笔健全        铅笔的每一条结论都在真解上（auditAgainst 违规 0）
//   G1 判定不被掐断   出货侧（final/ship）裁判 stopped = 0（carve 探针的击穿是设计内的，见下）
//   G2 确定性证人    生产路径**任何一次**击穿都必须归因到 nodeCap；归到 msCap 的一律红 ——
//                     ms 掐的盘随机器快慢变，那就不再是"同一 seed 串 ⇒ 同一张盘"
//   G3 两账相符      acc 流水里的 carve 击穿数 == carveIrreducible 自记的 keptByBudget
//   H 难度轴单调      沿梯子 givens 升、undecided 不许回升；Spearman 中位必须 < −0.5
//                     （y 无方差的退化梯不计入相关性，但计数打印出来）
//   I 定价表覆盖实测  band（每盘裁判调用次数）与 ladder（密度梯层数）必须包住这次样本
//
// "A green gate built on a wrong expectation is worse than a red one"：任何一条红都不许靠调低
// 阈值来治；要么改代码，要么在 docs/DESIGN.md 里用可运行的论证写清前提错在哪。

import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { TIERS, generate, gridFor, ladderRungs } from '../js/engine/generate.js';
import { verifyNumbering } from '../js/engine/rules.js';
import { provesUnique } from '../js/engine/counter.js';
import { countWitnessB } from '../js/engine/witness.js';
import { pencilSolve, auditAgainst } from '../js/engine/pencil.js';

const SAMPLES = Number(process.env.SAMPLES || 12);
if (!Number.isInteger(SAMPLES) || SAMPLES < 3) {
  console.error(`SAMPLES 要是 >=3 的整数（分位表在 3 个样本以下没有意义），实得 ${process.env.SAMPLES}`);
  process.exit(2);
}
const loadavg = () => { try { return execSync('sysctl -n vm.loadavg').toString().trim(); } catch { return 'n/a'; } };
const LOAD_BEFORE = loadavg();

const sortNum = (a) => a.slice().sort((x, y) => x - y);
const mean = (a) => (a.length ? a.reduce((s, x) => x + s, 0) / a.length : NaN);
// 与选型屏同一个分位定义（最近秩，四舍五入到格），换了它两张表就对不上。
const quant = (a, q) => {
  if (!a.length) return NaN;
  const s = sortNum(a);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const ranks = (xs) => {
  const idx = xs.map((x, i) => i);
  idx.sort((a, b) => xs[a] - xs[b] || a - b);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
};
function spearman(xs, ys) {
  if (xs.length < 3) return NaN;
  const rx = ranks(xs), ry = ranks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
/** 本组织的定价式（写在闸这一侧，这样 TIERS 里那两个数永远能被独立复算一次）。 */
const priceBand = (arr) => {
  const lo = Math.max(1, Math.floor(quant(arr, 0.5) * 0.4));
  return [lo, Math.max(lo + 1, Math.ceil(quant(arr, 0.95) * 1.6))];
};
const priceBudget = (arr) => Math.max(10, Math.ceil(quant(arr, 0.95) * 4 / 10) * 10);

console.log('================================================================================');
console.log('HIDATO BALANCE — 出货路径的平衡闸');
console.log(`samples   : ${SAMPLES} 张/档（seed = hidato|<size>|<i>，i=0..${SAMPLES - 1}；默认 seed 不由日期派生）`);
console.log(`loadavg   : before ${LOAD_BEFORE} · node ${process.version}`);
console.log('================================================================================');

const checks = [];
const addCheck = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`); };

const PROD_KINDS = new Set(['carve', 'final', 'ship']);      // QA 复核(kind='confirm')不进定价池
const per = {};
const fails = { path: 0, cert: 0, ladder: 0, ship: 0, other: 0 };
const wallAll = [];

for (const tier of TIERS) {
  const G = gridFor(tier);
  const rec = per[tier.key] = {
    ok: 0, notUnique: 0, badSolution: 0, notPencilSolvable: 0, pencilRevealMismatch: 0,
    witMismatch: 0, witNoReading: 0, stillUnique: 0, stillUniqueBudgetKept: 0, unproven: 0,
    lockedRedundant: 0, sound: 0, stopped: 0, stopByKind: { carve: 0, final: 0, ship: 0 },
    // 击穿是被**哪个闸**掐的：'nodes' 掐的只让盘更密（纯函数读数），'ms' 掐的会让同一个 seed 串
    // 在慢机器上出另一张盘 —— 那才是"确定性"破口。两者必须分开记，混成一个数就都读不出来。
    stopByCap: { nodes: 0, ms: 0, unknown: 0 }, keptByBudget: 0, rhoBad: 0,
    callsPerBoard: [], callMs: [], callNodes: [],
    draws: [], shipGivens: [], certGivens: [], rungIdx: [], steps: [], rho: [], regress: [],
    shipRefMs: [], wall: [], wallWithCert: [], shipCells: tier.n, witness: [], zeroBranch: 0,
  };
  console.log('');
  console.log(`── ${tier.key} (${tier.n} 格) ── TIERS band=${JSON.stringify(tier.band)} ladder=${JSON.stringify(tier.ladder)} attempts=${JSON.stringify(tier.attempts)} budgetMs=${tier.budgetMs} nodeCap=${tier.nodeCap} carve=${tier.carve.nodeCap}/${tier.carve.msCap}ms`);
  for (let i = 0; i < SAMPLES; i++) {
    const calls = [];
    const acc = (r, kind) => calls.push({ kind, ms: r.ms, nodes: r.nodes, outcome: r.outcome, by: r.stoppedBy });
    const t0 = performance.now();
    // confirm=true：QA 复核是 E 条红线的证人，它不进定价池（见文件头），所以一起跑不污染价格。
    const out = generate(tier.key, i, { acc, confirm: true });
    const wall = performance.now() - t0;
    rec.wall.push(wall);
    if (!out.ok) {
      if (out.fail === 'path') fails.path++;
      else if (out.fail === 'ladder') fails.ladder++;
      else if (String(out.fail).startsWith('cert-')) fails.cert++;
      else if (String(out.fail).startsWith('ship-')) fails.ship++;
      else fails.other++;
      console.log(`  ${tier.key}#${i} 出货失败 fail=${out.fail} —— 一张都不许放过`);
      continue;
    }
    rec.ok++;
    rec.wallWithCert.push(out.totalMs);
    const ship = out.ship;
    let prodCalls = 0;
    for (const c of calls) {
      if (!PROD_KINDS.has(c.kind)) continue;
      prodCalls++;
      rec.callMs.push(c.ms);
      rec.callNodes.push(c.nodes);
      // 按 kind 分开记：探针（carve）击穿是**设计内的**（40000 节点比出货的 250000 小一个数量级，
      // 后果是多留一条线索，方向安全）；出货侧（final/ship）击穿则是"唯一性没证完就当唯一卖出去"，
      // 那才是承诺破口。两种 stopped 混成一个数，红线就既可能假绿也可能假红。
      if (c.outcome === 'stopped') {
        rec.stopped++;
        if (c.kind in rec.stopByKind) rec.stopByKind[c.kind]++;
        // 归因到**哪个闸**：counter.js 每次击穿都带 stoppedBy，没有就是账本坏了（宁可红，不可猜）。
        rec.stopByCap[c.by === 'nodes' || c.by === 'ms' ? c.by : 'unknown']++;
      }
    }
    rec.callsPerBoard.push(prodCalls);
    rec.draws.push(out.draws);
    rec.steps.push(ship.steps);
    rec.rungIdx.push(ship.rung);
    rec.shipGivens.push(ship.givens);
    rec.certGivens.push(out.board.survivors.length);
    rec.shipRefMs.push(ship.refereeMs);
    rec.zeroBranch += ship.ref.zeroBranch ? 1 : 0;
    if (!provesUnique(ship.ref)) rec.notUnique++;                       // A
    if (verifyNumbering(G, ship.given, out.solution) !== 'ok') rec.badSolution++;   // B
    // C：**从题面重跑**一遍 BASIC 铅笔。梯子里自报的 solved 是出题器的账，本组织的规矩是
    // "出题器自记的答案会说谎" —— 独立重跑一次才算证人。
    const again = pencilSolve(G, ship.given, 'BASIC');
    if (!again.solved) rec.notPencilSolvable++;
    // 铅笔推完的盘，它推出的那张解必须与裁判的解是同一张（两条通道各自到达同一个答案）。
    let diff = 0;
    for (let v = 1; v <= tier.n; v++) if (again.solution[v] >= 0 && again.solution[v] !== out.solution[v]) diff++;
    if (again.solved && diff > 0) rec.pencilRevealMismatch++;
    // D 独立见证（零传播、固定升序、无距离剪枝）
    const w = countWitnessB(G, ship.given, {});
    rec.witness.push(w.outcome);
    if (w.outcome === 'stopped') rec.witNoReading++;
    else if (w.outcome !== ship.ref.outcome) rec.witMismatch++;
    // F 铅笔健全性：出货层的结论对裁判的解逐格对账
    const aud = auditAgainst(again, tier.key, ship.given, out.solution);
    rec.sound += aud.violations;
    // E 证书盘的不可约性（QA 复核的记账）
    rec.stillUnique += out.board.stillUnique;
    rec.stillUniqueBudgetKept += out.board.stillUniqueBudgetKept;
    rec.unproven += out.board.unproven;
    rec.lockedRedundant += out.board.lockedRedundant;
    // 同一事实的第二条独立记账路径：carveIrreducible 自己数的 keptByBudget（数探针），
    // 对上面 acc 流水里 carve 击穿数（数调用）。两条必须逐档相等，否则账本在骗人。
    rec.keptByBudget += out.board.keptByBudget;
    // H 难度轴：把这条梯**完整**重走一遍（出货路径只走到第一个推得完的层就停，量不到后面的形状）
    const full = ladderRungs(G, out.board, { strength: 'BASIC', walkAll: true });
    const gv = full.rungs.map((r) => r.givens), un = full.rungs.map((r) => r.undecided);
    const rho = spearman(gv, un);
    // 秩相关在"每一层都推得完"的盘上没有定义（undecided 恒 0 ⇒ y 无方差），那是**好盘**不是红：
    // 不可约核心自己就够铅笔推完（shipIdx=0）。必须把它从分位表里剔出去单独计数 —— 混进 NaN
    // 会让 sort 变成未定义顺序，中位数读出来像绿的其实是被污染的（本机 2026-09-29 实测三档各 1 张）。
    if (Number.isFinite(rho)) rec.rho.push(rho); else rec.rhoBad++;
    let reg = 0;
    for (let k = 1; k < gv.length; k++) if (un[k] > un[k - 1]) reg++;
    rec.regress.push(reg);
  }
  const t = (a) => `中位 ${f2(quant(a, 0.5))} / p95 ${f2(quant(a, 0.95))} / max ${f2(Math.max(...a))}`;
  console.log(`  出货 ${rec.ok}/${SAMPLES} · 生产路径裁判调用共 ${rec.callsPerBoard.reduce((s, x) => s + x, 0)} 次（每盘 ${t(rec.callsPerBoard)}）· 单次 ms ${t(rec.callMs)} · 节点 ${t(rec.callNodes)}`);
  console.log(`  击穿 ${rec.stopped} 次：按调用 ${JSON.stringify(rec.stopByKind)} · 按闸 ${JSON.stringify(rec.stopByCap)} · keptByBudget（第二条独立记账）${rec.keptByBudget}`);
  console.log(`  线索数 不可约 ${t(rec.certGivens)} → 出货 ${t(rec.shipGivens)} = 出货占格 ${f2(100 * mean(rec.shipGivens) / tier.n, 1)}%`);
  console.log(`  密度梯 层数 ${t(rec.steps)} · 出货层号 ${t(rec.rungIdx)} · draws ${t(rec.draws)}`);
  console.log(`  出货层裁判 ms ${t(rec.shipRefMs)} · 整盘生产墙钟（含 QA 复核）中位 ${f2(quant(rec.wall, 0.5))} / p95 ${f2(quant(rec.wall, 0.95))} / max ${f2(Math.max(...rec.wall))} ms · 不含 QA ${t(rec.wallWithCert)}`);
  console.log(`  难度轴 Spearman 中位 ${f2(quant(rec.rho, 0.5), 3)} / min ${f2(rec.rho.length ? Math.min(...rec.rho) : NaN, 3)} · 参与相关性的盘 ${rec.rho.length}/${SAMPLES}（剔掉 y 无方差的退化梯 ${rec.rhoBad} 张）· 回升台阶合计 ${rec.regress.reduce((s, x) => s + x, 0)} · 零分支证明 ${rec.zeroBranch}`);
  console.log(`  见证 B 读数 ${JSON.stringify(rec.witness.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {}))} · MISMATCH ${rec.witMismatch} · 铅笔 sound ${rec.sound}`);
  console.log(`  不可约复核 stillUnique ${rec.stillUnique} · 可归因探针预算 ${rec.stillUniqueBudgetKept} · 未证完 ${rec.unproven} · 端点策略多印 ${rec.lockedRedundant}`);
  console.log(`  按公式重算：band(每盘裁判调用)=${JSON.stringify(priceBand(rec.callsPerBoard))} · band(梯层数)=${JSON.stringify(priceBand(rec.steps))} · band(draws)=${JSON.stringify(priceBand(rec.draws))} · budgetMs=${priceBudget(rec.callMs)}`);
}

console.log('');
console.log('── 红线 ──');
const allRec = Object.values(per);
// regress / rho 这类**每盘一个数**的量存成数组；聚合器必须先把数组折成和，
// 否则 `s + [0,0,0]` 在 JS 里是字符串拼接（本机 2026-09-29 就这么把 H 读成过
// "回升台阶 00,0,0,0…" 然后判红 —— 数字是对的，是打印与判据在骗人）。
const fold = (v) => (Array.isArray(v) ? v.reduce((a, b) => a + b, 0) : v);
const sum = (k) => allRec.reduce((s, r) => s + fold(r[k]), 0);
const nOk = sum('ok');

// 每盘的裁判调用次数是纯函数（不看时钟），所以它能被 band 钉住。
// 而"每盘重抽几个 seed"（attempts）在本品类恒等于 1：biased 采样器接受率 199–200/200、
// 密度梯推不完率 0/120（屏 2026-09-28），没有拒绝采样 ⇒ 那个量退化，闸不验它（恒真的绿等于
// 没承诺）。TIERS.attempts 把这个"恒 1"明写出来当文档（为什么 band 不套通用式见文件头的定价一节）。
const failTotal = fails.path + fails.cert + fails.ladder + fails.ship + fails.other;

addCheck('A 出货唯一性', sum('notUnique') === 0 && fails.cert === 0 && fails.ship === 0,
  `非唯一 ${sum('notUnique')} · cert 失败 ${fails.cert} · ship 失败 ${fails.ship}（出货 ${nOk} 张）`);
addCheck('B 答案独立合法', sum('badSolution') === 0, `裁判解过 verifyNumbering 失败 ${sum('badSolution')}`);
addCheck('C 零猜测承诺（独立重跑 BASIC）', sum('notPencilSolvable') === 0,
  `BASIC 推不完的出货盘 ${sum('notPencilSolvable')}/${nOk}`);
addCheck('C2 铅笔与裁判同一张解', sum('pencilRevealMismatch') === 0, `两条通道解不一致 ${sum('pencilRevealMismatch')}`);
addCheck('D 独立见证一致', sum('witMismatch') === 0, `MISMATCH ${sum('witMismatch')} · 无读数 ${sum('witNoReading')}（stopped 不算分歧）`);
// E 分两类看，混成一个数就会既可能假绿也可能假红：
//   stillUnique      —— 幸存线索被**证明**删得掉 ⇒ 不可约证书是假的，出题器 bug，必须 0
//   stillUniqueBudgetKept —— 删得掉这件事只在探针预算内没证完 ⇒ 不是 bug，是两套预算口径的差；
//     但它必须**逐条归因得回**一次 carve 击穿（keptByBudget），归不上就是账本在瞎记。
addCheck('E 证书不可约（假证书为 0，因预算而留者可归因）', sum('stillUnique') === 0
  && allRec.every((r) => r.stillUniqueBudgetKept <= r.keptByBudget),
  `删了还唯一 ${sum('stillUnique')}（必须 0）· 因探针预算而留 ${sum('stillUniqueBudgetKept')} 条，逐档归因 ${allRec.map((r) => `${r.stillUniqueBudgetKept}≤${r.keptByBudget}`).join(' ')} · 未证完 ${sum('unproven')}（允许，记账）· 端点多印 ${sum('lockedRedundant')}（成例代价，记账）`);
addCheck('F 铅笔健全', sum('sound') === 0, `越权结论 ${sum('sound')}`);
// G 拆成三条，因为"预算没参与判定"其实是三件不同的事，原写法把探针的设计内击穿也算成红，
// 而 carve 击穿在 generate.js 文件头就是**明写的机制**（后果=多留一条线索，方向安全）。
const shipStopped = allRec.reduce((s, r) => s + r.stopByKind.final + r.stopByKind.ship, 0);
const capTot = (k) => allRec.reduce((s, r) => s + r.stopByCap[k], 0);
addCheck('G1 唯一性证明没被预算掐断', shipStopped === 0 && fails.ladder === 0 && fails.path === 0,
  `出货侧（final/ship）stopped ${shipStopped} · 梯推不完 ${fails.ladder} · 抽不到路径 ${fails.path}`);
addCheck('G2 ms 闸没参与判定（同 seed 同盘的前提）', capTot('ms') === 0 && capTot('unknown') === 0,
  `生产路径击穿按闸归因：nodeCap ${capTot('nodes')} 次（纯函数的量，只会把盘留得更密）· msCap ${capTot('ms')} 次（必须 0：只要 >0，慢一倍的机器就会对同一个 seed 串出**另一张盘**）· 归因不明 ${capTot('unknown')} 次`);
addCheck('G3 击穿的两条独立记账相等', allRec.every((r) => r.stopByKind.carve === r.keptByBudget),
  `逐档 acc 流水 carve 击穿 ${allRec.map((r) => r.stopByKind.carve).join(' / ')} vs carveIrreducible 自记 keptByBudget ${allRec.map((r) => r.keptByBudget).join(' / ')}`);
addCheck('H 难度轴单调', sum('regress') === 0 && allRec.every((r) => r.rho.length >= 3 && quant(r.rho, 0.5) < -0.5),
  `回升台阶 ${sum('regress')} · 各档 Spearman 中位 ${allRec.map((r) => f2(quant(r.rho, 0.5), 3)).join(' / ')} · 各档有效样本 ${allRec.map((r) => `${r.rho.length}/${SAMPLES}`).join(' / ')}（其余是 undecided 恒 0 的退化梯）`);
// I：TIERS 里那两个区间必须包住这次样本，包不住就是表编错了（或这次负载改了盘）
for (const tier of TIERS) {
  const rec = per[tier.key];
  if (!rec.ok) { addCheck(`I ${tier.key} 定价表覆盖实测`, false, '这一档一张都没出货，无法对账'); continue; }
  const inside = (band, arr) => Math.min(...arr) >= band[0] && Math.max(...arr) <= band[1];
  const okBand = inside(tier.band, rec.callsPerBoard);
  const okLadder = inside(tier.ladder, rec.steps);
  addCheck(`I ${tier.key} 定价表覆盖实测`, okBand && okLadder,
    `每盘裁判调用 ${Math.min(...rec.callsPerBoard)}–${Math.max(...rec.callsPerBoard)} vs band ${JSON.stringify(tier.band)} · 梯层数 ${Math.min(...rec.steps)}–${Math.max(...rec.steps)} vs ladder ${JSON.stringify(tier.ladder)}`);
}
if (fails.other) addCheck('未知失败形状', false, `fail 里出现了闸没预料到的形状：${JSON.stringify(fails)}`);

console.log('');
console.log(`loadavg after: ${loadavg()} · 出货失败合计 ${failTotal}（形状 ${JSON.stringify(fails)}）· 出货成功 ${nOk}/${TIERS.length * SAMPLES}`);
console.log(`墙上读数都是**上界**：本机 ${LOAD_BEFORE}，QA 复核开着（同一进程里多跑约 ${nOk} × 每盘线索数次裁判）。`);
const nFail = checks.filter((c) => !c.ok).length;
console.log(`RESULT balance ok=${nFail === 0} checks=${checks.length} fails=${nFail}`);
process.exit(nFail === 0 ? 0 : 1);
