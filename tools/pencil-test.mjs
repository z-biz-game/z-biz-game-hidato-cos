#!/usr/bin/env node
// 铅笔闸 · "零猜测"这条产品承诺的证人（soundness / 无搜索 / 门槛选择性 / 强度对照 / 确定性 / 负控）
//
// 跑：  node tools/pencil-test.mjs                   （默认 SAMPLES=10 张真盘/档，秒级）
//      SAMPLES=30 node tools/pencil-test.mjs        （真盘样本放大；合成段不受它影响）
//
// 铅笔（js/engine/pencil.js）是 R2..R8 命名规则的位图传播器，**不许搜索、不许回溯**。
// 它的"能不能推完"是难度问题，"推出来的东西对不对"是事故问题；本闸七节，每节都写清
// 什么改动会让它红，因为一条推翻不了的断言等于没写：
//
//   §1 soundness（对裁判的真解）  铅笔定在格 c 的数 v 必须满足 cellOf[v]===c，且它从任何格
//                      删掉的候选都不许正好是那一格的真值（auditAgainst）。60 张真盘 ×2 强度。
//                      红法：任何一条规则越权（R6/R7/R8 的距离或走廊算错、all-different 串格）。
//   §2 soundness（对**全部**解，比 §1 强）  拿独立见证 witness.js（零传播、固定升序、无剪枝）
//                      把解枚举出来，要求 reachable ⊆ dom：铅笔一次都不许删掉"某个解里成立"的
//                      取值。并断两件形状学的事：铅笔宣布 solved ⇒ 见证必须说 unique；
//                      铅笔宣布 contradiction ⇒ 见证必须说 none。
//                      红法：规则把"局部无支撑"写成"全局不可行"、把多解盘当唯一盘推完。
//   §3 无搜索（逐条门控）  BASIC 的每次开火都能在 RULE_NAMES 里点名（BASIC 跑时 R7/R8 恒 0）；
//                      关掉规则 id ⇒ 它自己那一条开火数必须严格下降、终局域只能是**超集**
//                      （删信息的能力不会因为我们少开一条规则而变强）。rounds 永远到不了
//                      MAX_ROUNDS=300（到得了就是传播在打摆，那是回溯型实现的形状）。
//                      红法：ruleSetOf 的开关失效、fires 下标与 RULE_NAMES 错位、R3 直接改写域
//                      绕过删除计数。注意 removals **不是**权力读数（见 §3 末的实测说明）。
//   §4 门槛有选择性  同一批 seed 上：不可约证书盘 BASIC **推不完**（每档至少 8 成），
//                      出货盘 BASIC **全部推得完**。两侧都给绝对分数 X/N，不给"绿"。
//                      红法：铅笔强到把不可约盘全推完（门槛恒真 ⇒ "零猜测"没有内容）、
//                      或出货器改了密度梯导致某张出货盘推不完（承诺破口）。
//   §5 强度对照  EXT 的推完率 ≥ BASIC、且**不存在** BASIC 推得完而 EXT 推不完的盘；
//                      EXT 的终局域 ⊆ BASIC；"不变宽"钉到格：加规则后多推完的张数必须为 0
//                      （真盘 60 + 合成抽样 180 + 3×3 全枚举 511 种印法，三条口径都是 0，实测值
//                      打印在 §5 的读数行里）。EXT 的独立权力用两条会被推翻的读数钉：
//                      合成盘上 EXT 终局**严格更小**的张数 ≥1、收敛轮数严格更少的张数 ≥1。
//                      "EXT 比 BASIC 多推完几张"在本品类量出来是 0（真盘 60 + 合成 180 + 3×3 全枚举
//                      511 种印法三条口径都是 0，读数打印出来，不写成断言 —— 见该节口径说明）。
//                      红法：R7/R8 的门控或 fires 下标坏掉（严格更小 → 0）、
//                      两条 EXT 规则引入状态泄漏（出现 BASIC-only 的盘）。
//   §6 确定性  同一输入两次调用逐字段相同（domSnapshot/solution/fires/ruleFires/removals/
//                      rounds/steps），pencilSolve 与 solve 走同一条路。红法：读时钟、
//                      读 Object 遍历序、模块级可变缓存。
//   §7 负对照  人为矛盾的题面必须被拒：相邻两印距离不为 1 ⇒ 出货的两档强度都必须报
//                      contradiction/dead（单开 R6 就能证伪，拒收的墙点名到规则），且 8 种规则组合
//                      都不许宣布推完；同格两数 ⇒ 铅笔**不**报矛盾（实测，见该节说明），
//                      这一条由 rules.js 的 givenConflict、裁判与两条见证拒掉，闸改断"铅笔绝不说
//                      solved"且它自报的那张盘过不了 verifyNumbering。再伪造一个"猜"出来的定值喂给
//                      auditAgainst，必须 100% 被抓 —— 这一节证明 §1 的审计不是空转。
//
// 参照：兄弟仓 z-biz-game-zebra-cos/tools/pencil-test.mjs 的六节结构（出场证人 / soundness /
// 对全部解 / 单调 / 权力边界 / 负控），判据全部是 Hidato 自己的（值轴连续性、王步支撑、密度梯）。

import {
  RULE_NAMES, RULE_ORDER, BASIC_RULES, EXT_RULES, FULL_RULES, STRENGTHS, pencilSolve, solve, auditAgainst,
} from '../js/engine/pencil.js';
import { TIERS, generate, produce, gridFor, samplePath, ladderRungs } from '../js/engine/generate.js';
import { countSolutions } from '../js/engine/counter.js';
import { buildGrid, givensFromSeq, verifyNumbering, givenConflict, toGivenCell, countGivens } from '../js/engine/rules.js';
import { countWitnessA, countWitnessB } from '../js/engine/witness.js';
import { makeRng } from '../js/engine/rng.js';

const SAMPLES = Number(process.env.SAMPLES || 10);
if (!Number.isInteger(SAMPLES) || SAMPLES < 3) {
  console.error(`SAMPLES 要是 >=3 的整数（推完率是分数，样本太少没有意义），实得 ${process.env.SAMPLES}`);
  process.exit(2);
}
const MAX_ROUNDS = 300;   // pencil.js 的轮数上限（未导出，这里按源码常量钉住；改了源码必须同步）

console.log('================================================================================');
console.log('HIDATO PENCIL-TEST — 零猜测承诺的证人');
console.log(`samples   : ${SAMPLES} 张/档 × ${TIERS.length} 档（不可约 ${SAMPLES}/档 + 出货 ${SAMPLES}/档）· seed = hidato|<size>|<i> · node ${process.version}`);
console.log('================================================================================');

let checks = 0, fails = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`);
};
const eq = (name, got, want) => ok(name, got === want, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
const pop = (x) => { let c = 0; while (x) { x &= (x - 1); c++; } return c; };
const bits = (r, n) => { let s = 0; for (let c = 0; c < n; c++) s += pop(r.domSnapshot.lo[c]) + pop(r.domSnapshot.hi[c]); return s; };
/** on 的位必须全在 off 的位里（off 是 on 的超集）；返回破口格数。 */
const domSuperset = (off, on, n) => {
  let bad = 0;
  for (let c = 0; c < n; c++) {
    if ((on.domSnapshot.lo[c] & ~off.domSnapshot.lo[c]) !== 0) bad++;
    if ((on.domSnapshot.hi[c] & ~off.domSnapshot.hi[c]) !== 0) bad++;
  }
  return bad;
};
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
/** 一张盘的印线数（rules.js 的 countGivens 是全仓唯一计数口径）。 */
const giv = (x) => countGivens(x.given);

// ── 样本池 ──────────────────────────────────────────────────────────────────
const IRR = [], SHIP = [];
for (const tier of TIERS) {
  const G = gridFor(tier);
  for (let i = 0; i < SAMPLES; i++) {
    const p = produce(tier.key, i, { confirm: false });
    if (p.ok) IRR.push({ tier, G, given: p.board.given, sol: p.solution, seed: p.seed, board: p.board });
    else {
      fails++; checks++;
      // 红了必须当场说清是"这台机器证不完"还是"这张题面根本不唯一"：这两件事的处置完全不同
      // （前者重测预算，后者是引擎/裁判坏了）。线索数也打出来——机器不同时 carve 的 ms 探针会
      // 放回头像不同的线索，题面形状本来就会变，只打 fail 会把这件事藏起来。
      const r = p.board && p.board.ref;
      console.log(`  FAIL produce ${tier.key}#${i} :: ${p.fail}` +
        (r ? ` · 裁判 outcome=${r.outcome} 归因=${r.stoppedBy} nodes=${r.nodes} ms=${r.ms.toFixed(2)}` : '') +
        ` · 预算 nodeCap=${tier.nodeCap}/msCap=${tier.budgetMs} carve=${tier.carve.nodeCap}/${tier.carve.msCap}ms` +
        (typeof p.givens === 'number' ? ` · 线索 ${p.givens}` : '') + ` · draws=${p.draws}`);
    }
    const g = generate(tier.key, 4000 + i);
    if (g.ok) SHIP.push({ tier, G, given: g.ship.given, sol: g.solution, seed: g.seed });
    else { fails++; checks++; console.log(`  FAIL generate ${tier.key}#${4000 + i} :: ${g.fail}`); }
  }
}
const POOL = IRR.concat(SHIP);
console.log(`样本：不可约证书盘 ${IRR.length} 张（${TIERS.map((t) => `${t.key} ${IRR.filter((x) => x.tier.key === t.key).length}`).join(' · ')}）+ 出货盘 ${SHIP.length} 张 = ${POOL.length} 张`);
console.log('');

// ── §1 soundness：每条结论都落在裁判的真解上 ───────────────────────────────
console.log('── §1 soundness（对裁判的真解）──');
{
  let viol = 0, placedElsewhere = 0, trueDeleted = 0, emptyDom = 0, audited = 0;
  let solvedButDiff = 0, solvedBoards = 0, illegal = 0;
  for (const x of POOL) {
    for (const spec of STRENGTHS) {
      const r = pencilSolve(x.G, x.given, spec);
      const a = auditAgainst(r, x.tier.key, x.given, x.sol);
      viol += a.violations; placedElsewhere += a.placedElsewhere; trueDeleted += a.trueValueDeleted;
      emptyDom += a.emptyDomaiCells;
      audited++;
      if (r.solved) {
        solvedBoards++;
        if (r.contradiction) solvedButDiff++;      // 自相矛盾的读数（solved 与 contradiction 不能同真）
        const cellOf = Int32Array.from(r.solution);
        if (verifyNumbering(x.G, x.given, cellOf) !== 'ok') illegal++;
        let diff = 0;
        for (let v = 1; v <= x.tier.n; v++) if (cellOf[v] !== x.sol[v]) diff++;
        if (diff) solvedButDiff++;
      }
    }
  }
  ok(`${audited} 次审计（${POOL.length} 张 × ${STRENGTHS.join('+')}）零越权`, viol === 0, `violations ${viol} = 定错格 ${placedElsewhere} + 删掉真值 ${trueDeleted} · 空域格 ${emptyDom}`);
  ok(`铅笔推完的 ${solvedBoards} 次，那张解与裁判的解逐格相同且过 verifyNumbering`, illegal === 0 && solvedButDiff === 0, `非法解 ${illegal} · 与裁判不一致或自相矛盾 ${solvedButDiff}`);
}

// ── §2 soundness（对全部解）：结论必须留在 reachable 里 ─────────────────────
console.log('');
console.log('── §2 soundness（对全部解 · 独立见证 witness.js 当证人）──');
{
  let covered = 0, over = 0, ghostSolved = 0, falseDead = 0, capped = 0, tooMany = 0, runs = 0;
  let solChecked = 0, witnessFake = 0;
  const outcomeRead = { unique: 0, multiple: 0, none: 0 };
  for (const [R, C, reps, dens] of [[3, 3, 150, 0.30], [4, 4, 150, 0.32], [5, 5, 90, 0.30]]) {
    const G = buildGrid(R, C), n = R * C;
    for (let s = 0; s < reps; s++) {
      const rnd = makeRng(`power|${R}x${C}|${s}`);
      const sp = samplePath(G, rnd);
      if (!sp.ok) continue;
      const full = givensFromSeq(sp.seq, n);
      const g = new Int32Array(n + 1).fill(-1);
      g[1] = full[1]; g[n] = full[n];
      for (let v = 2; v < n; v++) if (rnd() < dens) g[v] = full[v];
      const w = countWitnessB(G, g, { limitSolutions: 64, nodeCap: 400000, msCap: 500 });
      if (w.stopped) { capped++; continue; }
      if (w.count >= 64) { tooMany++; continue; }        // 收不满全部解 ⇒ reachable 不是全集，查不动
      outcomeRead[w.outcome]++;
      if (w.count === 0) continue;
      covered++;
      const reachLo = new Uint32Array(n), reachHi = new Uint32Array(n);
      for (const sol of w.solutions) {
        if (verifyNumbering(G, g, Int32Array.from(sol)) !== 'ok') witnessFake++;   // 证人自己得先合法
        solChecked++;
        for (let v = 1; v <= n; v++) {
          const c = sol[v];
          if (v <= 32) reachLo[c] |= 1 << (v - 1); else reachHi[c] |= 1 << (v - 33);
        }
      }
      for (const spec of ['BASIC', 'EXT']) {
        runs++;
        const p = pencilSolve(G, g, spec);
        for (let c = 0; c < n; c++) {
          if ((p.domSnapshot.lo[c] & reachLo[c]) !== reachLo[c]) over++;
          if ((p.domSnapshot.hi[c] & reachHi[c]) !== reachHi[c]) over++;
        }
        if (p.solved && w.outcome !== 'unique') ghostSolved++;
        if (p.contradiction && w.outcome !== 'none') falseDead++;
      }
    }
  }
  ok('证人先自证合法：见证 B 交回的每一条解都过 rules.js 的 verifyNumbering', witnessFake === 0,
    `${solChecked} 条见证解里 ${witnessFake} 条非法（若 >0，本节下面的 reach⊆dom 就是在拿假解对账）`);
  ok(`${covered} 张随机 CSP × ${runs / 2 | 0} 组：铅笔一次都没删掉"某个解里成立"的取值`, over === 0,
    `越权删位 ${over} · 可比 ${covered}（unique ${outcomeRead.unique} / multiple ${outcomeRead.multiple}）· 见证掐断 ${capped} · 解多于 64 而弃 ${tooMany}`);
  ok('铅笔宣布推完 ⇒ 见证必须说 unique（多解盘上不可能不猜就定完整张盘）', ghostSolved === 0, `假推完 ${ghostSolved} 次`);
  ok('铅笔宣布矛盾 ⇒ 见证必须说 none（有解的盘上不许判死）', falseDead === 0, `误报矛盾 ${falseDead} 次`);
}

// ── §3 无搜索：逐条门控 + 域单调 + 不撞轮数上限 ────────────────────────────
console.log('');
console.log('── §3 无搜索：每次开火都能点名，关掉一条规则只会更弱 ──');
{
  eq('fires 下标与 RULE_NAMES 一一对应（长度）', RULE_NAMES.length, 7);
  eq('RULE_ORDER = R1 + RULE_NAMES 的 id（port-check 逐下标对它）', JSON.stringify(RULE_ORDER), JSON.stringify(['R1', ...RULE_NAMES.map((s) => s.split(' ')[0])]));
  eq('BASIC_RULES ∪ EXT_RULES = FULL_RULES', JSON.stringify([...BASIC_RULES, ...EXT_RULES]), JSON.stringify(FULL_RULES));

  const gatePool = POOL.slice(0, Math.max(6, Math.round(POOL.length * 0.5)));
  let mislabel = 0, extInBasic = 0, roundCap = 0, removalOver = 0, supBad = 0, noWitness = [];
  let solvedWithDead = 0, specAgree = 0;
  const fireBoards = {}, fireBits = {}, removalUp = {};
  for (const id of RULE_ORDER) { fireBoards[id] = 0; fireBits[id] = 0; removalUp[id] = 0; }
  for (const x of gatePool) {
    for (const spec of ['BASIC', 'EXT']) {
      const r = pencilSolve(x.G, x.given, spec);
      if (r.fires.length !== RULE_NAMES.length) mislabel++;
      for (let k = 0; k < r.fires.length; k++) if (r.fires[k] !== r.ruleFires[RULE_NAMES[k].split(' ')[0]]) mislabel++;
      if (r.ruleFires.R1 !== r.givenLocks) mislabel++;
      if (spec === 'BASIC' && (r.ruleFires.R7 || r.ruleFires.R8)) extInBasic++;
      if (r.rounds >= MAX_ROUNDS) roundCap++;
      if (r.removals > x.tier.n * x.tier.n) removalOver++;
      if (r.solved && r.dead !== 0) solvedWithDead++;
    }
    const on = pencilSolve(x.G, x.given, FULL_RULES);       // 显式全集 = EXT 的名单
    const ext = pencilSolve(x.G, x.given, 'EXT');
    if (JSON.stringify([on.fires, on.rounds, on.removals, on.domSnapshot]) === JSON.stringify([ext.fires, ext.rounds, ext.removals, ext.domSnapshot])) specAgree++;
    for (const id of FULL_RULES) if (ext.ruleFires[id] > 0) { fireBoards[id]++; fireBits[id] += ext.ruleFires[id]; }
    fireBoards.R1 += on.givenLocks > 0 ? 1 : 0; fireBits.R1 += on.givenLocks;
    for (const id of FULL_RULES) {
      const off = pencilSolve(x.G, x.given, FULL_RULES.filter((z) => z !== id));
      if (on.ruleFires[id] > 0 && !(off.ruleFires[id] < on.ruleFires[id])) mislabel++;
      if (off.ruleFires[id] !== 0) mislabel++;
      supBad += domSuperset(off, on, x.tier.n);
      if (off.removals > on.removals) removalUp[id]++;
    }
  }
  ok('每条规则的出场证人（关掉它 ⇒ 它那一条开火数严格下降、且归零）', mislabel === 0,
    `开火下标与名字错位 / 关掉后没归零 / 该下降没下降：共 ${mislabel} 处`);
  ok('BASIC 跑时 R7/R8 恒为 0（EXT 的两条没混进 BASIC）', extInBasic === 0, `${extInBasic} 张盘在 BASIC 里开了 EXT 的火`);
  ok(`轮数永远到不了上限 ${MAX_ROUNDS}（到了就是传播在打摆，那是回溯实现的形状）`, roundCap === 0, `撞上限 ${roundCap} 次`);
  ok('removals 上界 = N²（一次删除一个位，重复删/重删说明状态在回滚）', removalOver === 0, `越界 ${removalOver} 次`);
  ok('关掉任意一条规则，终局域只能是超集（少一条规则不会多删一位）', supBad === 0, `破口 ${supBad} 位`);
  ok('solved 与 dead 不能同真（推完了就不该有空域格）', solvedWithDead === 0, `同时为真 ${solvedWithDead} 次`);
  ok(`显式全集 spec（R2..R8）与 'EXT' 逐字段同读数（${gatePool.length} 张）`, specAgree === gatePool.length,
    `一致 ${specAgree}/${gatePool.length} 张`);
  for (const id of FULL_RULES) if (!fireBoards[id]) noWitness.push(id);
  ok(`七条规则都有出场证人（样本 ${gatePool.length} 张）`, noWitness.length === 0,
    `没人用过的规则：${noWitness.join('/') || '无'} · 累计 ` + FULL_RULES.map((id) => `${id} ${fireBoards[id]} 张/${fireBits[id]} 位`).join(' · '));
  console.log(`  读数：R1（given-lock 记账）在 ${gatePool.length} 张上累计锁 ${fireBits.R1} 次；` +
    `EXT 独有的位 ` + EXT_RULES.map((id) => `${id} ${fireBits[id]}`).join(' / '));
  console.log('  说明：removals **不是**权力读数 —— 关掉一条规则后它可能反而变大（R3 是直接改写域做定值、'
    + `不计 removals，关掉它就得靠别的规则一位一位删）。本机实测"关掉后 removals 变多"的张数：`
    + FULL_RULES.map((id) => `${id} ${removalUp[id]}/${gatePool.length}`).join(' · ')
    + '。所以本节把权力读数钉在**该规则自己的开火数**与**终局域超集**两条上，两条都可推翻。');
}

// ── §4 门槛有选择性：不可约盘推不完、出货盘推得完 ───────────────────────────
console.log('');
console.log('── §4 门槛有选择性（产品地基：两侧都不是恒真）──');
{
  const rows = [];
  let irrUnsolvedAll = 0, irrAll = 0, shipSolvedAll = 0, shipAll = 0;
  for (const tier of TIERS) {
    const G = gridFor(tier);
    const irr = IRR.filter((x) => x.tier.key === tier.key), sh = SHIP.filter((x) => x.tier.key === tier.key);
    let bs = 0, es = 0;
    for (const x of irr) { if (pencilSolve(G, x.given, 'BASIC').solved) bs++; if (pencilSolve(G, x.given, 'EXT').solved) es++; }
    let sb = 0, se = 0;
    for (const x of sh) { if (pencilSolve(G, x.given, 'BASIC').solved) sb++; if (pencilSolve(G, x.given, 'EXT').solved) se++; }
    rows.push(`${tier.key} 不可约 BASIC ${bs}/${irr.length} EXT ${es}/${irr.length} · 出货 BASIC ${sb}/${sh.length} EXT ${se}/${sh.length}`);
    irrUnsolvedAll += irr.length - bs; irrAll += irr.length;
    shipSolvedAll += sb; shipAll += sh.length;
    const need = Math.ceil(irr.length * 0.8);
    const irrMed = med(irr.map(giv)), shipMed = med(sh.map(giv));
    ok(`${tier.key}：不可约盘里 BASIC 推不完至少 ${need}/${irr.length} 张（会被推翻的形状，不是"存在"）`,
      irr.length - bs >= need, `实测推不完 ${irr.length - bs}/${irr.length} 张 · 推得完 ${bs} 张 · 不可约线索中位 ${irrMed} 条`);
    ok(`${tier.key}：出货盘 BASIC 全部推得完（零猜测承诺在出货路径上成立）`, sb === sh.length, `实测 ${sb}/${sh.length}`);
    ok(`${tier.key}：出货盘比不可约核心密（推得完不是同一张盘）`, shipMed > irrMed,
      `不可约中位 ${irrMed} 条 → 出货中位 ${shipMed} 条（盘 ${tier.n} 格）`);
  }
  ok('合计：不可约推不完 / 出货全推完 两侧都成立', irrUnsolvedAll > 0 && shipSolvedAll === shipAll,
    `不可约推不完 ${irrUnsolvedAll}/${irrAll} · 出货推得完 ${shipSolvedAll}/${shipAll}`);
  console.log(`  逐档读数：${rows.join('\n            ')}`);
}

// ── §5 强度对照：EXT ≥ BASIC，且 EXT 不是装饰 ───────────────────────────────
console.log('');
console.log('── §5 强度对照（EXT 严格强于 BASIC 的证据写在删位与收敛上）──');
{
  let extSolved = 0, basicSolved = 0, basicOnly = 0, extOnly = 0, domBad = 0, roundsFewer = 0, roundsMore = 0, tot = 0;
  for (const x of POOL) {
    const b = pencilSolve(x.G, x.given, 'BASIC'), e = pencilSolve(x.G, x.given, 'EXT');
    tot++;
    if (b.solved) basicSolved++;
    if (e.solved) extSolved++;
    if (b.solved && !e.solved) basicOnly++;
    if (e.solved && !b.solved) extOnly++;
    domBad += domSuperset(b, e, x.tier.n);
    if (e.rounds < b.rounds) roundsFewer++; else if (e.rounds > b.rounds) roundsMore++;
  }
  ok('EXT 的推完率 ≥ BASIC（同一批盘）', extSolved >= basicSolved, `BASIC ${basicSolved}/${tot} · EXT ${extSolved}/${tot}`);
  ok('不存在 BASIC 推得完而 EXT 推不完的盘（EXT 不许比 BASIC 弱）', basicOnly === 0, `BASIC-only ${basicOnly} 张`);
  ok('EXT 的终局域 ⊆ BASIC 的终局域（加规则只会删得更多）', domBad === 0, `破口 ${domBad} 格`);
  ok('EXT 收敛更快或持平（轮数不回升）+ 至少一张真的更快', roundsMore === 0 && roundsFewer >= 1,
    `EXT 轮数更少的盘 ${roundsFewer}/${tot} · 更多的 ${roundsMore}`);

  // 合成随机题面：EXT 的**独立**权力（BASIC 最终也会删掉同一批位的话，严格更小就是 0）
  let tried = 0, strict = 0, extWinsCompletion = 0;
  for (const tier of TIERS) {
    const G = gridFor(tier);
    for (let s = 0; s < 20; s++) {
      const rnd = makeRng(`ext-power|${tier.key}|${s}`);
      const sp = samplePath(G, rnd);
      if (!sp.ok) continue;
      const full = givensFromSeq(sp.seq, tier.n);
      for (const dens of [0.2, 0.35, 0.5]) {
        const g = new Int32Array(tier.n + 1).fill(-1);
        g[1] = full[1]; g[tier.n] = full[tier.n];
        for (let v = 2; v < tier.n; v++) if (rnd() < dens) g[v] = full[v];
        tried++;
        const b = pencilSolve(G, g, 'BASIC'), e = pencilSolve(G, g, 'EXT');
        if (bits(e, tier.n) < bits(b, tier.n)) strict++;
        if (e.solved && !b.solved) extWinsCompletion++;
      }
    }
  }
  ok(`EXT 在合成盘上终局域**严格**小于 BASIC（R7/R8 有独立权力，不是空转）≥1 张`, strict >= 1,
    `${strict}/${tried} 张合成盘上 EXT 少留位`);
  // 3×3 全枚举：把"EXT 多推完"从抽样读数变成**穷举**读数（512 种印法 × 2 档，本档 n=9，微秒级）。
  // 这一段钉两条形状学的硬线：EXT 推完数不得少于 BASIC，且不许出现 BASIC-only；
  // "多推完"的张数在这里被打印成绝对值 —— 哪天 R7/R8 真买到推完率，它会自己变成非 0，
  // 那时要改的是下面那句口径说明，不是断言。
  const G3 = buildGrid(3, 3), n3 = 9;
  const seq3 = Int32Array.from([0, 4, 8, 7, 5, 2, 1, 3, 6]);   // 用对角腿的合法 3×3 王步链（rule-test §3 同一条）
  const full3 = givensFromSeq(seq3, n3);
  let e3 = 0, b3 = 0, only3 = 0, strict3 = 0, shapes3 = 0, skipped3 = 0;
  for (let mask = 1; mask < (1 << n3); mask++) {
    const g = new Int32Array(n3 + 1).fill(-1);
    for (let v = 1; v <= n3; v++) if (mask & (1 << (v - 1))) g[v] = full3[v];
    const cf = givenConflict(G3, g);
    if (cf) { skipped3++; continue; }                       // 一条链的任意印点子集都该自洽：非 0 就是规则表坏了
    shapes3++;
    const rb = pencilSolve(G3, g, 'BASIC'), re = pencilSolve(G3, g, 'EXT');
    if (rb.solved) b3++;
    if (re.solved) e3++;
    if (rb.solved && !re.solved) only3++;
    if (bits(re, n3) < bits(rb, n3)) strict3++;
  }
  ok(`3×3 全枚举 ${shapes3} 种印法：EXT 推完数 ≥ BASIC 推完数、无 BASIC-only（合法链的印点子集永不自相矛盾）`,
    e3 >= b3 && only3 === 0 && skipped3 === 0,
    `BASIC ${b3}/${shapes3} · EXT ${e3}/${shapes3} · BASIC-only ${only3} · 题面自矛盾 ${skipped3} · EXT 域严格更小 ${strict3}`);
  console.log(`  读数：EXT 比 BASIC 多推完的盘 ${extWinsCompletion}/${tried}（合成抽样）· ${extOnly}/${tot}（真盘）· ${e3 - b3}/${shapes3}（3×3 全枚举）。`);
  console.log('  口径说明：pencil.js 文件头就量到过"加规则 = 变强"在**推完率**上不成立' +
    '（屏 120 张不可约盘 BASIC 3/3/2 对 EXT 3/3/2，2026-09-28）；本机这一闸把它放大到 ' +
    `${tot} 张真盘 + ${tried} 张合成抽样 + 3×3 全枚举 ${shapes3} 种印法，` +
    `多推完的张数实测 ${extWinsCompletion} / ${extOnly} / ${e3 - b3}，三条都是 0。所以本节把"EXT 不是装饰"钉在` +
    '**删位与收敛速度**上（上面两条 ≥1 的断言都会因 R7/R8 门控失效而翻红），而不是钉在一个本品类量不出来的完成数差值上。');
}

// ── §6 确定性 ──────────────────────────────────────────────────────────────
console.log('');
console.log('── §6 确定性：同输入逐字段相同（不许读时钟）──');
{
  const snap = (r) => JSON.stringify([r.solved, r.contradiction, r.undecided, r.dead, r.rounds, r.removals, r.fires, r.givenLocks, Array.from(r.solution), r.domSnapshot]);
  let unstable = 0, crossBad = 0, stepsBad = 0, pairs = 0;
  for (const x of POOL) {
    for (const spec of ['BASIC', 'EXT', FULL_RULES, ['R2', 'R4'], ['R1', 'R7', 'R8']]) {
      const a = pencilSolve(x.G, x.given, spec), b = pencilSolve(x.G, x.given, spec);
      pairs++;
      if (snap(a) !== snap(b)) unstable++;
      const s = solve(x.G, x.given, { strength: spec });
      if (snap(s) !== snap(a)) crossBad++;
      const want = FULL_RULES.filter((id) => a.ruleFires[id] > 0).length;
      if (s.steps !== want) stepsBad++;
    }
  }
  eq(`${pairs} 组 double-run 的完整读数逐字段相同`, unstable, 0);
  eq('solve(size, clues, opts) 与 pencilSolve(G, givenCell, spec) 同一条路', crossBad, 0);
  eq('steps = 开过火的规则条数（闸用它验"关掉一条确实少开火"）', stepsBad, 0);
  // solve 的三种 size 写法必须给同一份读数（'RxC' / {R,C} / 已建好的 G）
  const x = POOL[0];
  const s1 = solve(x.tier.key, x.given), s2 = solve({ R: x.tier.R, C: x.tier.C }, x.given), s3 = solve(x.G, x.given);
  eq("solve 的 'RxC' / {R,C} / G 三种写法同一读数", snap(s1) === snap(s2) && snap(s2) === snap(s3), true);
  let bareThrows = 0;
  try { solve(x.tier.n, x.given); } catch { bareThrows++; }     // 裸数字被拒（N 的两种读法不许混）
  eq('solve 拒收裸数字（49 既是边长也是格数，读错就有一批盘要重测）', bareThrows, 1);
}

// ── §7 负对照 ──────────────────────────────────────────────────────────────
console.log('');
console.log('── §7 负对照：矛盾题面与伪造结论都必须被抓 ──');
{
  const G = buildGrid(5, 5), n = 25;
  const mk = (pairs) => { const g = new Int32Array(n + 1).fill(-1); for (const [v, c] of pairs) g[v] = c; return g; };
  // (a) 相邻两印距离不为 1（题面自己就没有解）
  const far = mk([[1, 0], [2, 24], [5, 12]]);
  eq('夹具自查：这一张确实是 givenConflict 说的 given-adjacency', givenConflict(G, far), 'given-adjacency');
  const farRef = countSolutions(G, far, {});
  eq('独立通道（裁判）也说这盘无解，且 reason 与 givenConflict 逐字相同', `${farRef.outcome}/${farRef.reason}`, 'none/given-adjacency');
  // 同一道题在 3×3 上做小盘版，好让**两条零传播见证**都能给读数（5×5 上见证 A 只会 stopped）：
  // 见证 B 过去不在"两个都印着的连续数字"之间查邻接（gap 枚举只查贴锚那一步），
  // 于是它会把这盘数成 multiple，甚至数成 unique —— 假证书。b11bb89 修掉，这里钉住不许回退。
  const G3x = buildGrid(3, 3);
  const far3 = new Int32Array(10).fill(-1); far3[1] = 0; far3[2] = 8; far3[6] = 4;
  eq('夹具自查（3×3 小盘版）：DIST((0,0),(2,2))=2 ⇒ givenConflict 报 given-adjacency', givenConflict(G3x, far3), 'given-adjacency');
  eq('同一道题的四个通道同读数：裁判 / 见证 A / 见证 B 都说 none，且 reason 用 rules.js 的词表', (() => {
    const ref = countSolutions(G3x, far3, {});
    const a = countWitnessA(G3x, far3, { limitSolutions: 4 });
    const b = countWitnessB(G3x, far3, { limitSolutions: 4 });
    return `${ref.outcome}/${ref.reason}|${a.outcome}/${a.stopped}|${b.outcome}/${b.reason}`;
  })(), 'none/given-adjacency|none/false|none/given-adjacency');
  const SPECS = [...STRENGTHS, ['R2'], ['R3'], ['R4'], ['R5'], ['R6'], ['R2', 'R3']];
  let farSolved = 0;
  const farReads = [];
  for (const spec of SPECS) {
    const r = pencilSolve(G, far, spec);
    if (r.solved) farSolved++;
    farReads.push(`${Array.isArray(spec) ? spec.join('+') : spec}⇒${r.contradiction ?? `undecided${r.undecided}`}`);
  }
  ok(`${SPECS.length} 种规则组合在无解题面上都不许宣布推完`, farSolved === 0, `宣布推完 ${farSolved} 次 · 读数 ${farReads.join(' | ')}`);
  const farRejects = STRENGTHS.filter((spec) => {
    const r = pencilSolve(G, far, spec);
    return r.contradiction || r.dead > 0;
  });
  ok('出货的两档强度必须把无解题面**证伪**（报 contradiction 或 dead，不只是卡住）', farRejects.length === STRENGTHS.length,
    `证伪了 ${farRejects.length}/${STRENGTHS.length} 档：${farRejects.join('/')}`);
  const farR6 = pencilSolve(G, far, ['R6']);
  ok('单开 R6（距离界）就能证伪它 ⇒ 拒收的承重墙点名到规则', Boolean(farR6.contradiction) || farR6.dead > 0,
    `R6 单开报 contradiction=${JSON.stringify(farR6.contradiction)} dead=${farR6.dead}`);
  const farRead = pencilSolve(G, far, 'BASIC');
  console.log('  读数：给定 1@(0,0)、2@(4,4) 的矛盾题面上，' + farReads.join(' · ') + '。');
  console.log('  口径说明：本节的原期望是"**每一种**规则组合都必须报 contradiction/dead"，那是**测试写错**：'
    + 'R2/R3/R4/R5 单独开火时谁也删不空任何格，盘只是"推不完"（undecided>0 是难度读数，不是事故，'
    + '见 pencil.js 对三态的分工），要求一个残缺的规则集去证伪题面等于要求它比整条 BASIC 更强。'
    + '证人：pencil.js 自己的三态约定 + 裁判 countSolutions（对同一题面给 outcome=none、reason 逐字相同）。'
    + '真正会出事的是"推完了"，所以断言落在 solved 上（对全部组合）+ contradiction/dead 上（对出货强度与 R6）。');

  // (b) 同格两数：铅笔**不**报矛盾。这是实测结果，不是漏判 —— 铅笔只做删候选/定值，
  // 两个数印在同一格时 given-lock 循环后写覆盖先写，题面退化成"少一条线索"，于是盘只是
  // 更难（undecided>0），而"矛盾"这件事由 rules.js 的 givenConflict 单独持有（它是全仓
  // 唯一的合法性定义，见 rules.js 文件头），裁判拿到它时直接走 outcome='none'。
  // 原期望"铅笔必须报 contradiction 或 dead"是**测试写错**：证人 = givenConflict + 裁判
  // countSolutions（本仓两条独立通道）都说这盘无解，而铅笔说"推不完"，两者不冲突；
  // 反过来要求铅笔自己再判一次题面形状，就会在 rules.js 之外写出第二份合法性定义。
  const dup = mk([[1, 0], [2, 1], [3, 2], [7, 2], [25, 24]]);
  eq('夹具自查：这一张是 duplicate-given-cell', givenConflict(G, dup), 'duplicate-given-cell');
  const dupRef = countSolutions(G, dup, {});
  eq('独立通道（裁判 + 见证 A + 见证 B）都说这盘无解', (() => {
    const a = countWitnessA(G, dup, { limitSolutions: 4 });
    const b = countWitnessB(G, dup, { limitSolutions: 4 });
    return `${dupRef.outcome}/${dupRef.reason}|${a.outcome}|${b.outcome}`;
  })(), 'none/duplicate-given-cell|none|none');
  let dupBad = 0, dupSolved = 0;
  for (const spec of STRENGTHS) {
    const r = pencilSolve(G, dup, spec);
    if (r.solved) dupSolved++;
    const cellOf = Int32Array.from(r.solution);
    for (let v = 1; v <= n; v++) if (cellOf[v] < 0) cellOf[v] = 0;         // 未定值填 0 也要被排列检查拒掉
    if (verifyNumbering(G, dup, cellOf) === 'ok') dupBad++;                // 铅笔的部分结论绝不许"合法"
  }
  ok('同格两数：铅笔绝不宣布推完', dupSolved === 0, `${STRENGTHS.length} 档强度里宣布推完 ${dupSolved} 次`);
  ok('同格两数：铅笔自报的那张盘过不了 verifyNumbering（题面检查与裁判各自拒它）', dupBad === 0, `${dupBad} 次被判合法`);
  const dupRead = pencilSolve(G, dup, 'BASIC');
  console.log(`  读数：同格两数的题面上 BASIC 报 contradiction=${JSON.stringify(dupRead.contradiction)} dead=${dupRead.dead} undecided=${dupRead.undecided}（"推不完"而不是"矛盾"，理由见上）`);

  // (c) 审计不是空转：往铅笔的域里塞一个**猜**出来的定值，§1 那条审计必须抓到
  const x = SHIP[0];
  const res = pencilSolve(x.G, x.given, 'BASIC');
  const clean = auditAgainst(res, x.tier.key, x.given, x.sol);
  let caught = 0, triedCells = 0;
  for (let c = 0; c < x.tier.n; c++) {
    const tv = (() => { for (let v = 1; v <= x.tier.n; v++) if (x.sol[v] === c) return v; return -1; })();
    const wrong = tv === 1 ? 2 : 1;
    const dom = { lo: Array.from(res.domSnapshot.lo), hi: Array.from(res.domSnapshot.hi) };
    dom.lo[c] = 1 << (wrong - 1); dom.hi[c] = 0;
    const sol = Int32Array.from(res.solution); sol[wrong] = c;
    triedCells++;
    if (auditAgainst({ solution: sol, domSnapshot: dom }, x.tier.key, x.given, x.sol).violations > 0) caught++;
  }
  eq(`负控：干净读数的审计违规为 0（${x.seed}）`, clean.violations, 0);
  eq(`负控：${triedCells} 次伪造定值全部被审计抓到`, caught, triedCells);

  // (d) toGivenCell 的入参形状与铅笔的耦合：{v,cell}[] 与 Int32Array 必须同一读数
  const asArr = [];
  for (let v = 1; v <= x.tier.n; v++) if (x.given[v] >= 0) asArr.push({ v, cell: x.given[v] });
  const r1 = pencilSolve(x.G, x.given, 'EXT'), r2 = pencilSolve(x.G, toGivenCell(x.G, asArr), 'EXT');
  eq('同一张题面的两种形状（数组/Int32Array）喂铅笔得到同一读数', JSON.stringify([r1.solved, r1.undecided, r1.removals, r1.domSnapshot]), JSON.stringify([r2.solved, r2.undecided, r2.removals, r2.domSnapshot]));

  // (e) 密度梯自己也是个证人：不可约盘推不完时，梯子上必须存在第一个推得完的层
  {
    let noRung = 0, ladderBoards = 0;
    for (const t of IRR.slice(0, Math.max(3, IRR.length / 3 | 0))) {
      const b = pencilSolve(t.G, t.given, 'BASIC');
      if (b.solved) continue;
      ladderBoards++;
      const lad = ladderRungs(t.G, t.board, { strength: 'BASIC' });
      if (!lad.solved || lad.shipIdx < 1) noRung++;
    }
    ok('每张推不完的不可约盘，密度梯上都有一个更密的层能推完（出货不是靠退回满盘）', noRung === 0,
      `${ladderBoards} 张里回退失败 ${noRung} 张`);
  }
}

console.log('');
console.log(`RESULT pencil-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
