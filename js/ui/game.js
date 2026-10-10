// 游戏模型 · Hidato（UI 层唯一的状态机）
//
// 三条硬口径，都写在代码里而不是文案里：
//   1. **本文件从头到尾没有拿到过答案**。出题只走 js/engine/generate.js 的 `generate(tierKey, seed)`
//      这一条出货路径（预算全从 TIERS 取，本文件一行都不许自带 —— 自带＝重新定价）。回包里的
//      `solution`、`board.path`、`ref.solutions`、`lad.rungs[].g` 都是**真值**：makeBoard() 在函数体内
//      就把它们丢掉，交出去的 board 只有 {tierKey,R,C,n,seedStr,clues,fingerprint,…}。
//      所以判分、提示、存档、渲染能读的只有"题面 + 玩家自己写的数"，不可能"对着答案抄"。
//   2. **判分只问"你写的这组编号满足 Hidato 的规则吗"**：rules.verifyNumbering(G, 题面, 玩家填的 v→格)。
//      它独立于裁判与铅笔，逐条读排列性 / 给定格 / 王步相邻三件事，返回 'ok' 才算赢。
//      出货盘的题面被裁判**证明**过唯一（proof.outcome==='unique' 且 !proof.stopped），所以
//      "满足规则的填满"必然就是那一盘 —— 这句话以 proof 读数出现，不是以"我对了一下答案"出现。
//   3. **提示只念 pencil.js 自己删出来的候选**：在"题面 ∪ 玩家已填"上跑 pencilSolve(…, BASIC_RULES)，
//      从 domSnapshot 里取一个**域已塌成单值且玩家还没写**的格。BASIC 一个都给不出 ⇒ 明说推不出，
//      绝不退回抄真值。（出货档位就是按"BASIC 推得完"选的梯层，所以正常情况下该给得出。）
//
// 数据形状与引擎一致：题面是 givenCell（Int32Array(n+1)，下标=数 v，值=格号，-1=没印）；
// 玩家的手是 cellVal（Int32Array(n)，下标=格号，值=v，0=空）。给定格在 cellVal 里预填且改不掉。

import { TIERS, generate, gridFor, tierOf } from '../engine/generate.js';
import { countSolutions } from '../engine/counter.js';
import { BASIC_RULES, pencilSolve } from '../engine/pencil.js';
import { fromGivenCell, givenConflict, isAdjacent, makeGiven, missingEndpoints, toGivenCell, verifyNumbering } from '../engine/rules.js';

export const EMPTY = 0;

/**
 * 出一张盘，并把它**压缩成不含答案的形状**。
 * 唯一的出题入口：`generate(tierKey, seed)`，不带任何预算参数（TIERS 才是价格的出处）。
 * opts.acc 只是**观察者**（generate.js 明确它不参与任何判定），用它把"每次裁判调用的 ms/nodes 上界"
 * 量出来写进回执 —— 浏览器侧的 ms 是否压进 10 ms 这个产品问题，就靠它在页面上有读数。
 * @returns {ok:true, tier, board, proof} | {ok:false, fail, draws, tier, proof}
 */
export function makeBoard(tierKey, seed) {
  const tier = tierOf(tierKey);
  const watch = { calls: 0, maxMs: 0, maxNodes: 0, stoppedByNodes: 0, stoppedByMs: 0 };
  const acc = (r) => {
    watch.calls++;
    if (r.ms > watch.maxMs) watch.maxMs = r.ms;
    if (r.nodes > watch.maxNodes) watch.maxNodes = r.nodes;
    if (r.stopped) (r.stoppedBy === 'ms' ? watch.stoppedByMs++ : watch.stoppedByNodes++);
  };
  const out = generate(tier.key, String(seed), { acc });
  // 只把**标量读数**从失败回包里折出来：失败回包带的 board / receipt / lad 里有 path 与 solutions，
  // 一个都不许往上挂。
  if (!out.ok) {
    return {
      ok: false, tier, fail: String(out.fail), draws: Number(out.draws) || 0, seedStr: String(out.seed),
      proof: { refereeCalls: watch.calls, refereeMaxMs: watch.maxMs, refereeMaxNodes: watch.maxNodes },
    };
  }
  const G = gridFor(tier);
  const ship = out.ship;
  // ↓ 从这里开始，代码里再没有出现 out.solution / out.board / out.ref.solutions / lad.rungs。
  //   clues 是**题面**（{v,cell}[]，rules.fromGivenCell 的唯一可序列化形状），不是解。
  const clues = fromGivenCell(ship.given);
  // 铅笔这条腿**页面自己再走一遍**（纯函数、亚毫秒）：出货档位号称"BASIC 推得完"，
  // 那句话必须由页面上跑的 pencilSolve 认，而不是由生成器回执里的一行注释认。
  // 认不过 ⇒ boardIsProven 交回 false ⇒ #reject 摊开，这张盘不作为题面发出去。
  const pen = pencilSolve(G, ship.given, BASIC_RULES);
  const proof = {
    outcome: out.ref.outcome, count: out.ref.count, stopped: out.ref.stopped, stoppedBy: out.ref.stoppedBy,
    nodes: out.ref.nodes, ms: out.ref.ms, multiWay: out.ref.multiWay, deadEnds: out.ref.deadEnds,
    maxGap: out.ref.maxGap, zeroBranch: out.ref.zeroBranch,
    givens: ship.givens, rung: ship.rung, ladderSteps: ship.steps, ladderMs: ship.ladderMs,
    shipRounds: ship.rounds, shipRemovals: ship.removals, shipRuleFires: ship.ruleFires,
    certFingerprint: out.certFingerprint, totalMs: out.totalMs,
    refereeCalls: watch.calls, refereeMaxMs: watch.maxMs, refereeMaxNodes: watch.maxNodes,
    stoppedByNodes: watch.stoppedByNodes, stoppedByMs: watch.stoppedByMs,
    pencilSolved: pen.solved, pencilUndecided: pen.undecided, pencilDead: pen.dead,
    pencilRounds: pen.rounds, pencilRemovals: pen.removals, pencilRuleFires: pen.ruleFires,
    pencilContradiction: pen.contradiction,
    endpoints: missingEndpoints(G, ship.given), conflict: givenConflict(G, ship.given),
  };
  const board = {
    tierKey: tier.key, label: tier.label, R: tier.R, C: tier.C, n: G.n,
    seed: String(seed), seedStr: String(out.seed), clues, clueCount: clues.length,
    draws: Number(out.draws) || 0, fingerprint: String(out.fingerprint),
  };
  return { ok: true, tier, board, proof };
}

/**
 * 一张盘能不能出货给玩家：**四条都认，缺一条就是未通过验收**。
 * proof 有两种来源：makeBoard() 的 generate 回执（带梯层读数），与 assessBoard() 的现算回执
 * （注入盘没有梯层可念，rung/ladderSteps 是 null ⇒ 不参与否决，其余四条照旧全认）。
 *   · stopped ⇒ 预算击穿，唯一性**没被证明**（count 可能也是 1，但那不是同一个事实）
 *   · outcome!=='unique' || count!==1 ⇒ 多解或无解
 *   · !pencilSolved ⇒ BASIC 推不完，玩家必然要在某一步猜 ⇒ 违反本组织的"零猜测"
 *   · endpoints ⇒ 1 与 N 没印全 ⇒ 不是 Hidato 的题面形状（见 rules.js 的端点不变量）
 */
export function boardIsProven(board, proof) {
  if (!board || !proof) return false;
  if (proof.stopped) return false;
  if (proof.outcome !== 'unique' || proof.count !== 1) return false;
  if (!proof.pencilSolved) return false;
  if (proof.endpoints != null) return false;
  if (proof.conflict != null) return false;
  return true;
}

/**
 * 现算一份验收回执（**不需要真值**，也不产生真值）：裁判数一遍 + BASIC 铅笔推一遍。
 * 给"注入一张盘"的路径用（浏览器闸的 canary 拿它喂推不完的盘与 stopped 的盘）。
 * opts 只在这一条注入腿上有意义：负样本靠**节点预算**掐断（节点数是纯函数，node 与浏览器同读数）。
 * shipped 路径永远不走这里，也永远不读 opts。
 */
export function assessBoard(tierKey, clues, opts = {}) {
  const tier = tierOf(tierKey);
  const G = gridFor(tier);
  const given = toGivenCell(G, clues);
  const ref = countSolutions(G, given, {
    nodeCap: opts.nodeCap ?? tier.nodeCap,
    msCap: opts.msCap ?? tier.budgetMs,
  });
  const pen = pencilSolve(G, given, BASIC_RULES);
  // 裁判回包里的 solutions 是真值：这里只取标量，数组本身不落进返回对象。
  return {
    outcome: ref.outcome, count: ref.count, stopped: ref.stopped, stoppedBy: ref.stoppedBy,
    nodes: ref.nodes, ms: ref.ms, multiWay: ref.multiWay, deadEnds: ref.deadEnds,
    maxGap: ref.maxGap, zeroBranch: ref.zeroBranch,
    givens: fromGivenCell(given).length, rung: null, ladderSteps: null,
    certFingerprint: null, totalMs: null,
    pencilSolved: pen.solved, pencilUndecided: pen.undecided, pencilRounds: pen.rounds,
    pencilRemovals: pen.removals, pencilRuleFires: pen.ruleFires, pencilContradiction: pen.contradiction,
    endpoints: missingEndpoints(G, given), conflict: givenConflict(G, given),
    budgetMs: opts.msCap ?? tier.budgetMs, nodeCap: opts.nodeCap ?? tier.nodeCap, injected: true,
  };
}

export class Game {
  /** @param board makeBoard() 交出的那个对象（里面没有 truth） */
  constructor(board) {
    this.board = board;
    const tier = tierOf(board.tierKey);
    this.G = gridFor(tier);
    this.tierKey = board.tierKey;
    this.label = board.label;
    this.R = board.R; this.C = board.C; this.n = board.n;
    this.seed = board.seed;
    this.seedStr = board.seedStr;
    this.clues = board.clues;
    this.fingerprint = board.fingerprint;
    /** 题面（v→格，-1=没印）：只读，任何写操作都不许动它。 */
    this.clueGiven = toGivenCell(this.G, board.clues);
    /** 每格现在的值（0=空）。给定格在这里预填，并且是**唯一**允许预填的格。 */
    this.cellVal = new Int32Array(this.n);
    this.givenCell = new Uint8Array(this.n);
    for (let v = 1; v <= this.n; v++) {
      const c = this.clueGiven[v];
      if (c >= 0) { this.cellVal[c] = v; this.givenCell[c] = 1; }
    }
    this.sel = this.firstOpen();                  // 选中的格
    this.armed = this.nextNeeded(0);              // 面板上按下去会写进选中格的那个值
    this.undoStack = [];
    this.steps = 0;
    this.hints = 0;
    this.hintStalls = 0;                          // BASIC 给不出提示的次数（出货盘上应为 0）
    this.hintMark = -1;                           // 高亮那一格（-1 = 没有；不落进玩家的手）
    this.solved = false;
    /** 铅笔读数只留**计数**（轮数/删除数/逐规则开火数）：整份 domSnapshot 不留存，
     *  存下来就等于把一条完整解题序列挂在对象图上。按提示时现算（纯函数、毫秒级）。 */
    this.pencil = this.pencilRead();
  }

  // ── 寻址 ───────────────────────────────────────────────────────────────────
  rowOf(cell) { return (cell / this.C) | 0; }
  colOf(cell) { return cell % this.C; }
  cellAt(row, col) { return row * this.C + col; }
  /** 人读的格名：第 r 行第 c 列。 */
  name(cell) { return `第 ${this.rowOf(cell) + 1} 行第 ${this.colOf(cell) + 1} 列`; }
  isGiven(cell) { return this.givenCell[cell] === 1; }
  valueAt(cell) { return this.cellVal[cell]; }
  /** 玩家已经写进去的格数（不含印着的）。 */
  myCells() { let k = 0; for (let c = 0; c < this.n; c++) if (this.cellVal[c] && !this.givenCell[c]) k++; return k; }
  filled() { let k = 0; for (let c = 0; c < this.n; c++) if (this.cellVal[c]) k++; return k; }
  firstOpen() { for (let c = 0; c < this.n; c++) if (!this.givenCell[c]) return c; return 0; }
  /** 待写的下一个值：从 after 往后绕一圈，跳过印着的数与已经落定的数。全填完 ⇒ 0（没有可写的）。 */
  nextNeeded(after) {
    for (let step = 1; step <= this.n; step++) {
      const v = ((after + step - 1) % this.n) + 1;
      if (this.clueGiven[v] < 0 && !this.holdsValue(v)) return v;
    }
    return 0;
  }
  holdsValue(v) { for (let c = 0; c < this.n; c++) if (this.cellVal[c] === v) return true; return false; }
  cellHolding(v) { for (let c = 0; c < this.n; c++) if (this.cellVal[c] === v) return c; return -1; }

  // ── 落子 ───────────────────────────────────────────────────────────────────
  /** 当前状态折成"部分 givenCell"（v→格，-1=没定）：题面 ∪ 玩家已填。冲突标记与提示都吃它。 */
  currentGiven() {
    const g = makeGiven(this.n);
    for (let c = 0; c < this.n; c++) { const v = this.cellVal[c]; if (v) g[v] = c; }
    return g;
  }
  select(cell) {
    if (!(cell >= 0 && cell < this.n)) return false;
    this.sel = cell;
    return true;
  }
  /** 方向键：移动选中格，**永不出盘**（钳在盘内，不环绕）。 */
  move(dr, dc) {
    const r = Math.max(0, Math.min(this.R - 1, this.rowOf(this.sel) + dr));
    const c = Math.max(0, Math.min(this.C - 1, this.colOf(this.sel) + dc));
    this.sel = this.cellAt(r, c);
    return true;
  }
  /** 把值 v 写进选中格。给定格不动、给定值不搬；同一个值在盘上永远只占一格（写下去会从原格移过来）。 */
  place(cell, v) {
    if (!(cell >= 0 && cell < this.n)) return { ok: false, why: 'out-of-range' };
    if (this.isGiven(cell)) return { ok: false, why: 'given-cell' };
    if (!(v >= 1 && v <= this.n)) return { ok: false, why: 'out-of-range' };
    if (this.clueGiven[v] >= 0) return { ok: false, why: 'given-value' };
    const prev = this.cellVal[cell];
    if (prev === v) return { ok: false, why: 'same' };
    const group = [{ cell, prev }];
    const holder = this.cellHolding(v);
    if (holder >= 0) { group.push({ cell: holder, prev: this.cellVal[holder] }); this.cellVal[holder] = EMPTY; }
    this.cellVal[cell] = v;
    this.undoStack.push(group);
    this.steps++;
    this.hintMark = -1;
    this.solved = false;
    this.sel = cell;
    this.armed = this.nextNeeded(v);
    return { ok: true, cell, value: v, moved: group.length > 1 };
  }
  /** 面板按一下：写进当前选中格（交互模型只有一种，点格只负责选中）。 */
  press(v) { return this.place(this.sel, v); }
  /** `+` / `-`：选中格的值在 1..n 内加减一（给定格不动；空格按 `+` 从 1 起）。 */
  nudge(delta) {
    if (this.isGiven(this.sel)) return { ok: false, why: 'given-cell' };
    const cur = this.cellVal[this.sel];
    const from = cur || (delta > 0 ? 0 : 2);
    let v = from + delta;
    if (v < 1 || v > this.n) return { ok: false, why: 'out-of-range' };
    while (v >= 1 && v <= this.n && this.clueGiven[v] >= 0) v += delta;   // 印着的数不在玩家可写的范围里
    if (v < 1 || v > this.n) return { ok: false, why: 'out-of-range' };
    return this.place(this.sel, v);
  }
  /** ⌫ / Delete：清空选中格（印着的格不许清）。 */
  erase() { return this.setEmpty(this.sel); }
  setEmpty(cell) {
    if (this.isGiven(cell)) return { ok: false, why: 'given-cell' };
    const prev = this.cellVal[cell];
    if (!prev) return { ok: false, why: 'already-empty' };
    this.undoStack.push([{ cell, prev }]);
    this.cellVal[cell] = EMPTY;
    this.steps++;
    this.hintMark = -1;
    this.solved = false;
    // 空出来的那个数若比当前armed更小，就重新armed它 —— 链子上的洞优先补。
    this.armed = this.armed === 0 || prev < this.armed ? prev : this.armed;
    return { ok: true, cell };
  }
  undo() {
    const group = this.undoStack.pop();
    if (!group) return false;
    for (const e of group) this.cellVal[e.cell] = e.prev;
    this.steps = Math.max(0, this.steps - 1);
    this.hintMark = -1;
    this.solved = false;
    this.armed = this.nextNeeded(0);
    return true;
  }
  clearAll() {
    for (let c = 0; c < this.n; c++) if (!this.givenCell[c]) this.cellVal[c] = EMPTY;
    this.undoStack.length = 0;
    this.hintMark = -1;
    this.solved = false;
    this.steps = 0;
    this.sel = this.firstOpen();
    this.armed = this.nextNeeded(0);
    this.pencil = this.pencilRead();
  }
  /**
   * 重开**同一道题**：把这一局整个归零。
   *
   * 为什么不拿 clearAll() 当重开：它清的是"盘面"，不是"这一局"。提示这一路会往
   * hints / hintStalls 上记账，clearAll 一个都碰不到，于是重开后的回执还挂着上一局的
   * 提示次数，而 hintStalls（BASIC 在这道题上推不出的次数，出货盘应为 0）更严重 ——
   * 把它带进新局，回执会拿上一局的旧账去报一道盘面的缺陷。那是假红，不能留。
   *
   * 提示还会真的泄题：hint() 跑在**当前玩家状态**上，推出的那格是白送的答案。
   * 带着旧 hints 计数重开，等于让玩家白拿一次提示而账面上不记；反过来把提示高亮
   * 留着不动，新局一开场就有一格被圈出来。所以 hintMark 也归零。
   */
  resetAll() {
    this.clearAll();
    this.hints = 0;         // 提示次数：这一局的账，不能带到下一局
    this.hintStalls = 0;    // 出货质量计数：更不能带到下一局，否则回执拿旧账报盘面缺陷
    this.hintMark = -1;     // 提示高亮：留着就是新局开场白里白圈出来的一格（clearAll 已做，写明是为了点名）
  }

  // ── 冲突标记：只用题面与玩家已经写的数，不碰任何真值 ────────────────────────
  /**
   * 断了的边 = 值轴上相邻的两个数都已定、但这两格不王步相邻。
   * 几何只从 rules.isAdjacent 读（本仓对"挨着"的唯一拼写），这里只负责**列全**：
   * rules.givenConflict 交回第一个理由字符串，逐条边由本函数摊开给渲染层画。
   */
  conflicts() {
    const merged = this.currentGiven();
    const broken = [];
    for (let v = 1; v < this.n; v++) {
      const a = merged[v], b = merged[v + 1];
      if (a < 0 || b < 0) continue;
      if (!isAdjacent(this.G, a, b)) broken.push({ at: v, from: a, to: b, given: this.isGiven(a) || this.isGiven(b) });
    }
    return { reason: givenConflict(this.G, merged), broken, cells: broken.flatMap((e) => [e.from, e.to]) };
  }
  counts() {
    const given = this.board.clueCount;
    const mine = this.myCells();
    return { n: this.n, filled: given + mine, given, mine, empty: this.n - given - mine };
  }

  // ── 提示：pencil.js 自己删出来的候选，一个都不抄 ────────────────────────────
  pencilRead() {
    const pen = pencilSolve(this.G, this.currentGiven(), BASIC_RULES);
    return {
      solved: pen.solved, undecided: pen.undecided, dead: pen.dead, contradiction: pen.contradiction,
      rounds: pen.rounds, removals: pen.removals, fires: pen.ruleFires, givenLocks: pen.givenLocks,
    };
  }
  /**
   * 按一下"提示"：在**当前玩家状态**上跑 BASIC，取第一个"域塌成单值且玩家还没写"的格。
   * 交回的对象里只有一个数与一个格号，没有整份候选表（domSnapshot 只在函数体内活一瞬）。
   */
  hint() {
    const pen = pencilSolve(this.G, this.currentGiven(), BASIC_RULES);
    this.pencil = {
      solved: pen.solved, undecided: pen.undecided, dead: pen.dead, contradiction: pen.contradiction,
      rounds: pen.rounds, removals: pen.removals, fires: pen.ruleFires, givenLocks: pen.givenLocks,
    };
    this.hints++;
    if (pen.contradiction) {
      this.hintStalls++;
      return { kind: 'contradiction', text: `这一步 BASIC 推不出：题面 ∪ 你已填的数被推出矛盾（${pen.contradiction}）。撤销或清空重写这一格。`, rounds: pen.rounds, removals: pen.removals };
    }
    const lo = pen.domSnapshot.lo, hi = pen.domSnapshot.hi;
    for (let c = 0; c < this.n; c++) {
      if (this.cellVal[c]) continue;                    // 玩家自己写过的格不算提示
      let v = -1, bits = 0;
      for (let k = 0; k < 32; k++) if ((lo[c] >>> k) & 1) { bits++; v = k + 1; }
      for (let k = 0; k < 32; k++) if ((hi[c] >>> k) & 1) { bits++; v = k + 33; }
      if (bits === 1 && v > 0 && v <= this.n) {
        this.hintMark = c;
        this.sel = c;
        this.armed = v;
        return { kind: 'cell', cell: c, row: this.rowOf(c), col: this.colOf(c), value: v, text: `${this.name(c)} 只能写 ${v} —— BASIC 把这一格的候选删到只剩它（${pen.rounds} 轮 / ${pen.removals} 次删除）`, rounds: pen.rounds, removals: pen.removals };
      }
    }
    this.hintStalls++;
    return { kind: 'stall', text: `这一步 BASIC 推不出（${pen.undecided} 格还剩多个候选）。出货盘不该走到这里 —— 把这个 seed 报给引擎侧。`, undecided: pen.undecided, rounds: pen.rounds, removals: pen.removals };
  }
  clearHint() { this.hintMark = -1; }

  // ── 判分：把玩家自己填的编号交给 rules.verifyNumbering ──────────────────────
  /** @returns {complete, missing, verdict, ok, text} verdict 就是引擎那个原样字符串 */
  judge() {
    const cellOf = makeGiven(this.n);
    for (let c = 0; c < this.n; c++) { const v = this.cellVal[c]; if (v) cellOf[v] = c; }
    const verdict = verifyNumbering(this.G, this.clueGiven, cellOf);
    let missing = 0;
    for (let c = 0; c < this.n; c++) if (!this.cellVal[c]) missing++;
    const complete = missing === 0;
    if (verdict === 'ok') this.solved = true;
    return { complete, missing, verdict, ok: verdict === 'ok', broken: this.conflicts().broken.length };
  }

  // ── 存档（entries 只编码**玩家写的**格；印着的格恒为 00） ──────────────────
  encode() {
    const mine = new Int32Array(this.n);
    for (let c = 0; c < this.n; c++) if (!this.givenCell[c]) mine[c] = this.cellVal[c];
    return mine;
  }
  /**
   * 解码失败 ⇒ false（调用方当作没有存档）。逐条验：长度、每个数在 1..n、数不重复、
   * 不许落在给定格上、不许是题面里印着的数 —— 宁可丢档也不画一张鬼盘。
   */
  decode(values) {
    if (!values || values.length !== this.n) return false;
    const seen = new Uint8Array(this.n + 1);
    const next = new Int32Array(this.n);
    for (let c = 0; c < this.n; c++) {
      const v = values[c];
      if (v === 0) continue;
      if (!(v >= 1 && v <= this.n) || seen[v]) return false;
      if (this.isGiven(c) || this.clueGiven[v] >= 0) return false;
      seen[v] = 1;
      next[c] = v;
    }
    for (let c = 0; c < this.n; c++) if (!this.givenCell[c]) this.cellVal[c] = next[c];
    this.undoStack.length = 0;
    this.hintMark = -1;
    this.sel = this.firstOpen();
    this.armed = this.nextNeeded(0);
    this.pencil = this.pencilRead();
    return true;
  }
}

export { TIERS };
