// 入口 · 智渡 Hidato（可玩的页面，也是下一条回合浏览器闸的被测对象）
//
// 三条口径写在这里，不写在文案里：
//   1. **seed 永远不是日期算出来的**。取值优先级：URL 查询串（?seed=&tier=）→ hidato.save.v1 存档
//      → 默认 `h0`。「换一局」把盘号串尾部的整数 +1（`h7`→`h8`；无尾数则补 1，`abc`→`abc1`），
//      所以每一次点击得到的是**一个可打印、可原样重发的串**，不是"这一秒的第几张盘"。
//      本组织在 suguru / battleship 上修过两次 date-derived seed：那种"换一局"复现不出来，
//      而且 CI 隔天换一批盘，门禁读数与线上货对不上。同一个 seed 串在 node 与浏览器里必须是
//      同一张盘 —— 引擎的随机数全从 seed 串派生（见 js/engine/rng.js），这一条由本文件不碰时钟来兑现。
//   2. **页面上没有答案字段**。出题只走 generate(tierKey, seed) 这一条出货路径，且**不带预算参数**
//      （预算的出处是 TIERS，自带＝重新定价）；makeBoard() 在函数内部就把回包里的真值链丢掉，
//      交回来的 board 只有 {tierKey,R,C,n,seedStr,clues,fingerprint,…}。判分把**玩家自己写的**编号
//      交给 rules.verifyNumbering，提示只念 pencil.js 自己删剩的候选。闸拿 node 侧算出的真值
//      扫 window.hidato 的对象图、DOM 与 localStorage，扫到就是红。
//   3. **渲染不做判定**：任何"这盘是不是货"的话都来自引擎读数（generate 的裁判回执 + 页面自己
//      再走一遍的 BASIC 铅笔）；验收不过 ⇒ 摊开 #reject 并把 #board-wrap（含 #palette）收起。
//      UI 不许把未证明唯一的盘当题面发出去，也不许把铅笔推不完的盘当"不猜也能做完"发出去。

import { TIERS, tierOf } from './engine/generate.js';
import { BoardView, measure } from './render/board.js';
import { Game, assessBoard, boardIsProven, makeBoard } from './ui/game.js';
import { SAVE_KEY, clear as clearSave, decodeEntries, encodeEntries, load, save } from './store.js';

const $ = (id) => document.getElementById(id);
const dom = {
  tier: $('tier'), seed: $('seed'), next: $('btn-next'), hint: $('btn-hint'),
  undo: $('btn-undo'), clear: $('btn-clear'), judge: $('btn-judge'), restart: $('btn-restart'),
  status: $('status'), filled: $('stat-filled'), steps: $('stat-steps'), conflict: $('stat-conflict'),
  boardWrap: $('board-wrap'), board: $('board'), palette: $('palette'), armedNote: $('armed-note'),
  hintLine: $('hint'), verdict: $('verdict'), receipt: $('receipt'),
  reject: $('reject'), rejectDetail: $('reject-detail'), saveNote: $('save-note'),
};

const app = {
  game: null, proof: null, view: new BoardView(dom.board, dom.palette),
  proven: false, saveOk: true, rejected: null, lastHint: null, judgeOut: null,
};

const DEFAULT_TIER = TIERS[0].key;
const DEFAULT_SEED = 'h0';
const params = new URLSearchParams(location.search);

/** 落子被拒的原因 → 一句话。这里只翻译**交互规则**，不翻译任何引擎结论。 */
const WHY = {
  'given-cell': '这一格是印着的题面，不能改也不能清',
  'given-value': '这个数已经印在盘上了，搬不动它',
  'out-of-range': '这个数不在 1..n 里',
  'already-empty': '这一格本来就是空的',
  same: '这一格已经写着这个数了',
};

/**
 * 盘号的下一步：尾部整数 +1。纯字符串运算 ⇒ 同一台机器、同一天、同一秒按两次也给两个不同的号，
 * 而且这个号能原样贴回 URL 复现同一张盘。
 */
function nextSeedString(cur) {
  const s = String(cur || '');
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return `${s || 'h'}1`;
  return `${m[1]}${Number(m[2]) + 1}`;
}

/** URL > 存档 > 默认。这一句是本品类 seed 口径的全部实现，别在这里加时钟。 */
function requestedBoard(saved) {
  const tier = params.get('tier') || (saved && saved.tier) || DEFAULT_TIER;
  const seed = params.get('seed') || (saved && saved.seed) || DEFAULT_SEED;
  const okTier = TIERS.some((t) => t.key === tier) ? tier : DEFAULT_TIER;
  return { tier: okTier, seed: String(seed).slice(0, 24) || DEFAULT_SEED };
}

// ── 画 ───────────────────────────────────────────────────────────────────────
/** 断边上的两个格 = 冲突格；判定全在 ui/game.js（它只读题面与玩家已填），这里只折成集合。 */
function conflictSet() {
  const g = app.game;
  const set = new Set();
  if (!g) return set;
  for (const c of g.conflicts().cells) set.add(c);
  return set;
}
function paint() {
  const g = app.game;
  if (!g) return;
  app.view.build(g);
  app.view.sync(g, { conflict: conflictSet(), hint: g.hintMark, armed: g.armed });
}

// ── 读数与文案 ───────────────────────────────────────────────────────────────
function renderReadouts() {
  const g = app.game;
  if (!g) return;
  const c = g.counts();
  dom.filled.textContent = `已填 ${c.filled}/${c.n}（印着 ${c.given} · 你写 ${c.mine}）`;
  dom.steps.textContent = `${g.steps} 手`;
  const cf = g.conflicts();
  dom.conflict.textContent = cf.broken.length ? `冲突 ${cf.broken.length} 处 · ${cf.reason}` : '';
  dom.conflict.classList.toggle('bad', cf.broken.length > 0);
  dom.armedNote.textContent = g.armed ? `· 下一个写 ${g.armed}` : '· 都写完了，按「判定」';
  dom.hintLine.textContent = app.lastHint ? app.lastHint.text : (g.solved ? '这条链已经成了。' : '');
  // 键名写在**最前面**：闸按"这一句以键名开头"读它，用户 Ctrl-F 搜 hidato.save.v1 也在句首命中。
  dom.saveNote.textContent = app.saveOk
    ? `${SAVE_KEY} 存档 · 盘号 ${g.seed} · ${g.steps} 手 · ${g.hints} 次提示 · 键里只有 tier/seed/entries/steps/hints`
    : `${SAVE_KEY} 写不进去（无痕或配额满）：这一局只活在内存里`;
}
/** 收据 = 引擎在这一盘上记的账，逐条是读数不是形容词。指纹那两个串的分工也写在这里。 */
function renderReceipt() {
  const g = app.game;
  if (!g) return;
  const p = app.proof || {};
  const tier = tierOf(g.tierKey);
  const fires = Object.entries(p.pencilRuleFires || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ') || '无';
  const c = g.counts();
  const lines = [
    `seed 串        ${g.seedStr}`,
    `盘号（可重发）  ${g.seed} · 档位 ${g.tierKey}（${g.R}×${g.C} = ${g.n} 格）`,
    `题面            ${c.given} 条印着的数（含端点 1 与 ${g.n}） · 抽路径 ${g.board.draws} 次`,
    `唯一性          ${p.outcome}（count=${p.count} · stopped=${p.stopped} · ${p.nodes} 节点 / ${(p.ms ?? 0).toFixed(3)} ms）`,
    `铅笔（页面现算）  ${p.pencilSolved ? 'BASIC 空盘推完' : `BASIC 剩 ${p.pencilUndecided} 格未定`} · ${p.pencilRounds} 轮 · ${p.pencilRemovals} 次删除 · ${fires}`,
    `梯层            第 ${p.rung} 层 / 共 ${p.ladderSteps} 层 · 生成侧读数 ${p.shipRounds} 轮 / ${p.shipRemovals} 次删除`,
    `裁判开销        ${p.refereeCalls} 次调用 · 单次最大 ${(p.refereeMaxMs ?? 0).toFixed(3)} ms / ${p.refereeMaxNodes} 节点（预算 ${tier.budgetMs} ms / ${tier.nodeCap} 节点）`,
    `预算击穿        nodes ${p.stoppedByNodes ?? 0} 次 · ms ${p.stoppedByMs ?? 0} 次${p.stoppedByMs ? ' ⇒ ms 闸参与了判定，同一串在别的机器上会出另一张盘' : ''}`,
    `指纹            ${g.fingerprint}（出货盘 · 页面与 node 侧比这个） · 证书盘 ${p.certFingerprint}（port-check 第 36 列比的是那个）`,
    `搜索树          分支点 ${p.multiWay} · 死路 ${p.deadEnds} · 最长 gap ${p.maxGap} · 零分支证明 ${p.zeroBranch}`,
    `提示            ${g.hints} 次 · BASIC 给不出 ${g.hintStalls} 次${g.hintStalls ? '（出货盘不该出现，报给引擎侧）' : ''}`,
    `验收            ${app.proven ? '通过 · 可以出货' : '未通过 ⇒ 不作为题面发出去'}`,
  ];
  dom.receipt.textContent = lines.join('\n');
}

// ── 判定：把玩家自己写的编号交给 rules.verifyNumbering ────────────────────────
function judgeAnswer() {
  const g = app.game;
  if (!g) return null;
  const out = g.judge();
  app.judgeOut = out;
  dom.verdict.hidden = false;
  dom.verdict.classList.remove('ok', 'bad');
  if (!out.complete) {
    dom.verdict.textContent = `还有 ${out.missing} 格没写，判不了（引擎：${out.verdict}）。断边 ${out.broken} 处。`;
    dom.verdict.classList.add('bad');
  } else if (!out.ok) {
    dom.verdict.textContent = `不成立 · 引擎理由 ${out.verdict}`;
    dom.verdict.classList.add('bad');
  } else {
    dom.status.textContent = `完成 · ${g.label} · 盘号 ${g.seed} · ${g.steps} 手 · ${g.hints} 次提示`;
    dom.verdict.textContent = `1..${g.n} 是一条王步相邻的链，且每个数各占一格 —— 全部 ${g.board.clueCount} 条题面数为真。` +
      `这盘的解被裁判穷举证明过唯一（${app.proof && app.proof.outcome}），所以你写出来的就是那一盘。`;
    dom.verdict.classList.add('ok');
  }
  paint();
  renderReadouts();
  renderReceipt();
  persist();
  return { ...out, text: dom.verdict.textContent };
}

function showReject(detail) {
  app.rejected = detail;
  app.proven = false;
  dom.reject.hidden = false;
  dom.rejectDetail.textContent = detail;
  dom.status.textContent = '本盘未通过验收 · 不作为题面发出去';
  dom.boardWrap.hidden = true;
  renderReceiptIfBoard();
}
function hideReject() {
  dom.reject.hidden = true;
  dom.rejectDetail.textContent = '';
  dom.boardWrap.hidden = false;
  app.rejected = null;
}
/** 没盘可画时收据也要能说清"为什么没有货"，但绝不编一张假盘。 */
function renderReceiptIfBoard() {
  if (!app.game) dom.receipt.textContent = (app.rejected || '').replace(/^/gm, '（无题面）');
}

// ── 开一局 ───────────────────────────────────────────────────────────────────
function openBoard(tierKey, seed, restore) {
  const made = makeBoard(tierKey, seed);
  if (!made.ok) {
    // 生成器抽不到货是**引擎的事实**：把拒收账原样念出来，不画一张假盘、不换 seed 重试。
    app.game = null;
    window.hidato.game = null;              // 句柄上的 game 必须跟着换，否则读到的是上一局
    app.proof = made.proof;
    dom.seed.value = seed;
    dom.tier.value = made.tier.key;
    showReject(`盘号 ${seed} 在档位 ${tierKey} 没有出货：fail=${made.fail} · 抽路径 ${made.draws} 次 · 裁判调用 ${made.proof.refereeCalls} 次`);
    return { ok: false, made };
  }
  hideReject();
  const game = new Game(made.board);
  let resumed = false;
  if (restore && restore.tier === tierKey && restore.seed === game.seed) {
    const vals = decodeEntries(restore.entries, game.n);
    resumed = !!vals && game.decode(vals);
    if (resumed) {
      game.steps = Math.max(0, Number(restore.steps) || 0);
      game.hints = Math.max(0, Number(restore.hints) || 0);
    }
  }
  app.game = game;
  window.hidato.game = game;              // 换一局 / 改档位 / 改盘号都从这里过，句柄不许留在上一局
  app.proof = made.proof;
  app.proven = boardIsProven(made.board, made.proof);
  app.lastHint = null;
  app.judgeOut = null;
  dom.verdict.hidden = true;
  dom.verdict.classList.remove('ok', 'bad');
  dom.tier.value = tierKey;
  dom.seed.value = game.seed;
  dom.status.textContent = app.proven ? `已出货 · ${game.label} · 盘号 ${game.seed}` : '未通过验收';
  paint();
  renderReadouts();
  renderReceipt();
  persist();
  if (!app.proven) {
    showReject([
      `裁判：outcome=${made.proof.outcome} count=${made.proof.count} stopped=${made.proof.stopped}（stoppedBy=${made.proof.stoppedBy}）`,
      `铅笔：${made.proof.pencilSolved ? 'BASIC 推完' : `剩 ${made.proof.pencilUndecided} 格未定`} · contradiction=${made.proof.pencilContradiction} · dead=${made.proof.pencilDead}`,
      `端点：missingEndpoints=${made.proof.endpoints} · 题面冲突=${made.proof.conflict}`,
      '这四类读数缺一条就不是货 —— 页面不把未证明唯一的盘当题面发出去。',
    ].join('\n'));
  }
  return { ok: true, game, proof: made.proof, resumed };
}

function persist() {
  if (!app.game) return;
  const g = app.game;
  app.saveOk = save(localStorage, {
    tier: g.tierKey, seed: g.seed, entries: encodeEntries(g.encode()), steps: g.steps, hints: g.hints,
  });
  renderReadouts();
}

/** 一次落子/一步操作之后的统一收尾：重画 + 重算冲突 + 存档。 */
function afterMove() {
  const g = app.game;
  if (!g) return;
  app.lastHint = null;
  g.clearHint();
  paint();
  renderReadouts();
  renderReceipt();
  persist();
}

// ── 真指针与键盘 ─────────────────────────────────────────────────────────────
app.view.onCell = (cell) => {
  const g = app.game;
  if (!g) return;
  g.select(cell);                        // 交互模型只有一种：点格 = 选中
  app.lastHint = null;
  g.clearHint();
  paint();
  renderReadouts();
};
app.view.onNumber = (v) => {
  const g = app.game;
  if (!g) return;
  const res = g.press(v);
  if (!res.ok) {
    app.lastHint = { text: WHY[res.why] || `这一步没写进去（${res.why}）` };
    paint();
    renderReadouts();
    return;
  }
  dom.verdict.hidden = true;
  afterMove();
  if (g.filled() === g.n) judgeAnswer();
};
function onKey(ev) {
  const g = app.game;
  if (!g) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = ev.key;
  let moved = false, handled = true;
  if (k === 'ArrowLeft') { g.move(0, -1); moved = true; }
  else if (k === 'ArrowRight') { g.move(0, 1); moved = true; }
  else if (k === 'ArrowUp') { g.move(-1, 0); moved = true; }
  else if (k === 'ArrowDown') { g.move(1, 0); moved = true; }
  else if (k === '+' || k === '=') g.nudge(1);
  else if (k === '-' || k === '_') g.nudge(-1);
  else if (k === 'Backspace' || k === 'Delete') g.erase();
  // R 重开同一题。本仓原先没有任何键占着字母：方向键走格，+/- 调 armed，⌫/Del 擦格，
  // 所以 R 是空的，不需要挪别的键。重开在**局中就能按**，不只盘填满后 ——
  // 玩家走到一半发现这条链子走错了，当场 R 一下原地重来，不必先填满再重来。
  else if (k === 'r' || k === 'R') { restart(); return; }
  else handled = false;
  if (!handled) return;
  ev.preventDefault();                     // 方向键不许滚页，⌫ 不许退历史
  if (moved) { paint(); renderReadouts(); return; }
  dom.verdict.hidden = true;
  afterMove();
}

// 键盘腿只挂一处：挂在 window 上，焦点在盘上也在面板上也走得动。
// 同一条 keydown 若同时绑在 #board 与 window 上会被处理两次（方向键一次走两格）。
window.addEventListener('keydown', onKey);
window.addEventListener('resize', paint);
dom.tier.addEventListener('change', () => openBoard(dom.tier.value, dom.seed.value.trim() || DEFAULT_SEED));
dom.seed.addEventListener('change', () => openBoard(dom.tier.value, dom.seed.value.trim() || DEFAULT_SEED));
dom.next.addEventListener('click', () => openBoard(dom.tier.value, nextSeedString(dom.seed.value.trim())));
dom.hint.addEventListener('click', () => {
  const g = app.game;
  if (!g) return;
  app.lastHint = g.hint();
  paint();
  renderReadouts();
  renderReceipt();
  persist();
});
dom.undo.addEventListener('click', () => {
  const g = app.game;
  if (!g) return;
  g.undo();
  afterMove();
});
dom.clear.addEventListener('click', () => {
  const g = app.game;
  if (!g) return;
  g.clearAll();
  app.lastHint = null;
  dom.verdict.hidden = true;
  paint();
  renderReadouts();
  renderReceipt();
  persist();
});
/**
 * 重开**同一道题**：这一局的痕迹全归零，题面不动。
 *
 * 和「清空」的区别就一条，但那条是承重的：清空只擦盘面，提示那一路的账（hints /
 * hintStalls）原封不动留着。提示是真的泄题 —— hint() 跑在当前玩家状态上，推出的那格
 * 是白送的答案；而 hintStalls 是出货质量计数（这道盘上 BASIC 推不出的次数，出货盘应为 0），
 * 带着旧账进新局，回执会拿上一局的账去报这道盘面的缺陷，那是假红。
 * 所以重开必须走 g.resetAll()，不能拿 clearAll() 顶替。
 *
 * 题面级的 app.proof / app.proven 特意**不**碰：它们是这一**道题**的验收凭证，
 * 同题重开凭证照旧成立；擦掉它等于谎称"这道盘没验过"。
 */
function restart() {
  const g = app.game;
  if (!g) return null;
  g.resetAll();
  app.lastHint = null;        // 上一条提示文案，属于上一局
  app.judgeOut = null;        // 上一局点「验收」得出的结论，同理
  dom.verdict.hidden = true;  // 判定条收起来，别把上一局的结论压在新盘上
  paint();
  renderReadouts();
  renderReceipt();
  persist();                  // 存档覆盖成本局的空盘：刷新不会又冒出走错那半局
  return g;
}
dom.restart.addEventListener('click', restart);
dom.judge.addEventListener('click', () => judgeAnswer());

for (const t of TIERS) {
  const opt = document.createElement('option');
  opt.value = t.key;
  opt.textContent = t.label;
  dom.tier.appendChild(opt);
}

// ── 对外形状：浏览器闸读这个对象；里面不该有任何答案字段 ────────────────────────
window.hidato = {
  version: '2.0.0',
  app,
  game: null,
  view: app.view,
  dom,
  tiers: TIERS,
  doc: { timeOrigin: String(performance.timeOrigin), href: location.href },
  measure,
  nextSeedString,
  open(tierKey, seed, restore) {
    const r = openBoard(tierKey || DEFAULT_TIER, seed, restore);
    window.hidato.game = app.game;
    return r.ok ? summary(r.game) : { ok: false, fail: r.made.fail, draws: r.made.draws };
  },
  playSeed(seed, tierKey) { return window.hidato.open(tierKey, String(seed)); },
  state() {
    const g = app.game;
    if (!g) return null;
    const cf = g.conflicts();
    return {
      ...summary(g),
      entries: encodeEntries(g.encode()),
      conflicts: cf.broken.length,
      conflictReason: cf.reason,
      conflictCells: cf.cells,
      counts: g.counts(),
      filled: g.filled(),
      pencil: { solved: g.pencil.solved, rounds: g.pencil.rounds, removals: g.pencil.removals, fires: { ...g.pencil.fires } },
      proof: app.proof ? {
        outcome: app.proof.outcome, count: app.proof.count, stopped: app.proof.stopped, stoppedBy: app.proof.stoppedBy,
        nodes: app.proof.nodes, ms: app.proof.ms, givens: app.proof.givens, rung: app.proof.rung,
        ladderSteps: app.proof.ladderSteps, pencilSolved: app.proof.pencilSolved,
        refereeCalls: app.proof.refereeCalls, refereeMaxMs: app.proof.refereeMaxMs, refereeMaxNodes: app.proof.refereeMaxNodes,
        stoppedByNodes: app.proof.stoppedByNodes, stoppedByMs: app.proof.stoppedByMs,
        certFingerprint: app.proof.certFingerprint, endpoints: app.proof.endpoints,
      } : null,
      hintStalls: g.hintStalls, saveKey: SAVE_KEY, saveOk: app.saveOk, proven: app.proven,
    };
  },
  // 供探针调：重开同一题。放在这个对象上而不是只挂在按钮上，是为了让浏览器闸能
  // 真的驱动一次重开、读 BEFORE/AFTER，而不必去合成鼠标点击。
  restart,
  hint() {
    const g = app.game;
    if (!g) return null;
    const step = g.hint();
    app.lastHint = step;
    paint();
    renderReadouts();
    renderReceipt();
    persist();
    if (!step) return null;
    return {
      kind: step.kind, cell: step.cell, row: step.row, col: step.col, value: step.value,
      text: step.text, rounds: step.rounds, removals: step.removals, undecided: step.undecided,
    };
  },
  judge: judgeAnswer,
  place: (cell, v) => { const g = app.game; if (!g) return null; const r = g.place(cell, v); afterMove(); return r; },
  press: (v) => { const g = app.game; if (!g) return null; const r = g.press(v); if (r.ok) afterMove(); return r; },
  select: (cell) => { const g = app.game; if (!g) return null; const r = g.select(cell); paint(); renderReadouts(); return r; },
  move: (dr, dc) => { const g = app.game; if (!g) return null; const r = g.move(dr, dc); paint(); renderReadouts(); return r; },
  nudge: (d) => { const g = app.game; if (!g) return null; const r = g.nudge(d); if (r.ok) afterMove(); return r; },
  erase: () => { const g = app.game; if (!g) return null; const r = g.erase(); if (r.ok) afterMove(); return r; },
  gate: {
    /**
     * 注入一张外部给的盘（闸的 canary 用它喂"推不完"与"stopped"的盘）：现算验收，不过就摊开。
     * budget 只给闸用：stopped 那块负样本靠**节点预算**掐断（节点数是纯函数，node 与浏览器同读数），
     * 省略时走生产档位预算 tier.budgetMs —— shipped 路径永远不传 budget。
     */
    loadBoard(tierKey, clues, budget) {
      const tier = tierOf(tierKey);
      let proof;
      try {
        proof = assessBoard(tier.key, clues, assessOpts(tier, budget));
      } catch (e) {
        // 形状都读不开的注入盘：摊开来说话，不画半张盘（档位键本身错了就该抛给调用方）。
        app.game = null;
        app.proof = null;
        showReject(`注入盘的题面读不开：${e.message}`);
        return { proven: false, error: e.message, rejectedShown: true, boardHidden: true, paletteHidden: true };
      }
      const board = {
        tierKey: tier.key, label: tier.label, R: tier.R, C: tier.C, n: tier.n,
        seed: 'injected', seedStr: `injected|${tier.key}`, clues, clueCount: clues.length,
        draws: 0, fingerprint: null,
      };
      const game = new Game(board);
      app.game = game;
      app.proof = proof;
      app.proven = boardIsProven(board, proof);
      app.lastHint = null;
      window.hidato.game = game;
      dom.tier.value = tier.key;
      dom.verdict.hidden = true;
      if (app.proven) {
        hideReject();
        dom.status.textContent = `注入盘 · ${tier.label} · 验收通过`;
      }
      paint();
      renderReadouts();
      renderReceipt();
      if (!app.proven) {
        showReject([
          `注入盘验收未过：outcome=${proof.outcome} count=${proof.count} stopped=${proof.stopped}（stoppedBy=${proof.stoppedBy}）`,
          `铅笔：${proof.pencilSolved ? 'BASIC 推完' : `剩 ${proof.pencilUndecided} 格未定`} · contradiction=${proof.pencilContradiction}`,
          `端点：missingEndpoints=${proof.endpoints} · 题面冲突=${proof.conflict}`,
        ].join('\n'));
      }
      return {
        proven: app.proven, outcome: proof.outcome, count: proof.count, stopped: proof.stopped,
        stoppedBy: proof.stoppedBy, nodes: proof.nodes, ms: proof.ms,
        pencilSolved: proof.pencilSolved, pencilUndecided: proof.pencilUndecided,
        endpoints: proof.endpoints, conflict: proof.conflict,
        rejectedShown: !dom.reject.hidden, boardHidden: dom.boardWrap.hidden,
        paletteHidden: dom.palette.offsetParent === null,     // 面板在 #board-wrap 里 ⇒ 收起就该测不到
        budget: { msCap: proof.budgetMs, nodeCap: proof.nodeCap },
      };
    },
    assess(tierKey, clues, budget) { return assessBoard(tierKey, clues, assessOpts(tierOf(tierKey), budget)); },
    wipeSave() { clearSave(localStorage); return localStorage.getItem(SAVE_KEY); },
    saveRaw() { return localStorage.getItem(SAVE_KEY); },
    shipped(tierKey, seed) { return makeBoard(tierKey || DEFAULT_TIER, seed || DEFAULT_SEED); },
  },
};

/** 验收用的预算：默认 = 生产档位预算；闸传 budget 时用它钉着的那组数（负样本靠节点预算掐断）。 */
function assessOpts(tier, budget) {
  return { msCap: budget?.msCap ?? tier.budgetMs, nodeCap: budget?.nodeCap ?? tier.nodeCap };
}

function summary(g) {
  return {
    tier: g.tierKey, tierKey: g.tierKey, seed: g.seed, seedStr: g.seedStr,
    fingerprint: g.fingerprint, R: g.R, C: g.C, n: g.n,
    steps: g.steps, hints: g.hints, solved: g.solved,
    clueCount: g.board.clueCount, selected: g.sel, armed: g.armed,
    proven: app.proven, status: dom.status.textContent,
  };
}

// 启动：URL → 存档 → 默认，一步都不涉及时钟。
const saved = load(localStorage);
const bootReq = requestedBoard(saved);
dom.tier.value = bootReq.tier;
dom.seed.value = bootReq.seed;
const boot = openBoard(bootReq.tier, bootReq.seed, saved);
window.hidato.game = app.game;
window.hidato.boot = { requested: bootReq, resumed: !!(boot.ok && boot.resumed), hasSaveAtBoot: !!saved };

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}
