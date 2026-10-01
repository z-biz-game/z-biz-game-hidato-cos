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
import { FxLayer } from './render/fx.js';
import { Sfx } from './audio.js';
import { Game, assessBoard, boardIsProven, makeBoard } from './ui/game.js';
import { SAVE_KEY, clear as clearSave, decodeEntries, encodeEntries, load, save } from './store.js';

const $ = (id) => document.getElementById(id);
const dom = {
  tier: $('tier'), seed: $('seed'), next: $('btn-next'), hint: $('btn-hint'),
  undo: $('btn-undo'), clear: $('btn-clear'), judge: $('btn-judge'),
  pause: $('btn-pause'), restart: $('btn-restart'), mute: $('btn-mute'),
  full: $('btn-full'), help: $('btn-help'), hudNote: $('hud-note'), helpPanel: $('help'),
  fx: $('fx'),
  status: $('status'), filled: $('stat-filled'), steps: $('stat-steps'), conflict: $('stat-conflict'),
  boardWrap: $('board-wrap'), board: $('board'), palette: $('palette'), armedNote: $('armed-note'),
  hintLine: $('hint'), verdict: $('verdict'), receipt: $('receipt'),
  reject: $('reject'), rejectDetail: $('reject-detail'), saveNote: $('save-note'),
};

const app = {
  game: null, proof: null, view: new BoardView(dom.board, dom.palette),
  proven: false, saveOk: true, rejected: null, lastHint: null, judgeOut: null,
  fx: null, sfx: new Sfx(), paused: false, helpOpen: false, fullscreen: false,
  unlocked: false,            // AudioContext 只在**第一次真手势**之后才建（autoplay 策略）
  tapCell: -1,                // pointerdown → click 的同一次点按去重令牌（下一帧清）
  restartLog: null,           // 重开前后的复位读数（时钟/步数/粒子/涟漪/链段/手数/已填）
  reduceMotionQuery: null,
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
  syncFx();
}

// ── 特效层的几何输入 ─────────────────────────────────────────────────────────
// 覆盖层是**视口坐标**画在 position:fixed 的画布上（CSS 像素，dpr 换算在 fx.resize 里做），
// 所以每次重画、滚动、缩放之后都要重新快照一次；仿真本身不读 DOM（布局抖动会污染对拍读数）。
function centerOf(cell) {
  const r = app.view.cellRect(cell);
  return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2, r: Math.max(6, Math.min(r.w, r.h) / 2) } : null;
}
/** 已写出的相邻数对 = 链段；两端都落子且**王步相邻**才算"成链"（strong），否则是断口。 */
function chainLinks(g) {
  const out = [];
  for (let v = 1; v < g.n; v++) {
    const a = g.cellHolding(v);
    const b = g.cellHolding(v + 1);
    if (a < 0 || b < 0) continue;
    const ca = centerOf(a);
    const cb = centerOf(b);
    if (!ca || !cb) continue;
    const adjacent = Math.max(Math.abs(g.rowOf(a) - g.rowOf(b)), Math.abs(g.colOf(a) - g.colOf(b))) === 1;
    out.push({ x0: ca.x, y0: ca.y, x1: cb.x, y1: cb.y, strong: adjacent });
  }
  return out;
}
function syncFx() {
  const fx = app.fx;
  if (!fx) return;
  if (!app.game || dom.boardWrap.hidden) { fx.setLinks([]); fx.setGlow(null); return; }
  fx.setLinks(chainLinks(app.game));
  fx.setGlow(centerOf(app.game.sel));
}

// ── HUD 动作（每个都真改状态，读数交给 app.restartLog / fx.stats / sfx.stats）────
function renderHud() {
  if (!dom.hudNote) return;
  const bits = [];
  if (app.paused) bits.push('已暂停 · 按 P 或点「暂停」继续');
  if (dom.mute) dom.mute.setAttribute('aria-pressed', app.sfx.muted ? 'true' : 'false');
  if (dom.pause) dom.pause.setAttribute('aria-pressed', app.paused ? 'true' : 'false');
  if (dom.help) dom.help.setAttribute('aria-pressed', app.helpOpen ? 'true' : 'false');
  if (dom.full) dom.full.setAttribute('aria-pressed', app.fullscreen ? 'true' : 'false');
  const st = app.sfx.stats();
  if (st.contextOpen) bits.push(`音效 ${st.voices} 个音${app.sfx.muted ? '（静音中·挂起）' : ''}`);
  dom.hudNote.textContent = bits.join(' · ');
  dom.hudNote.classList.toggle('busy', app.paused);
}

function setPaused(on) {
  app.paused = !!on;
  if (app.fx) app.fx.setFrozen(app.paused);
  document.body.classList.toggle('paused', app.paused);
  if (window.hidato && window.hidato.hud) window.hidato.hud.phase = app.paused ? 'paused' : 'playing';
  renderHud();
  return app.paused;
}
function togglePause() { return setPaused(!app.paused); }

/** 重开 = 同一张盘回到起点：时钟/粒子/链段/涟漪/临时增益/盘面读数一律归零，并把前后读数留下。 */
function restart() {
  const g = app.game;
  if (!g) return null;
  const before = { ...app.fx.stats(), steps: g.steps, filled: g.filled(), sfxVoices: app.sfx.voices };
  setPaused(false);
  app.fx.reset();
  app.sfx.reset();
  app.fx.setLinks([]);
  app.fx.setGlow(null);
  const opened = openBoard(g.tierKey, g.seed, null);     // restore=null ⇒ 不读存档，从空盘开始
  const after = { ...app.fx.stats(), steps: app.game ? app.game.steps : 0, filled: app.game ? app.game.filled() : 0, sfxVoices: app.sfx.voices };
  app.restartLog = { before, after, seed: g.seed, ok: !!opened.ok };
  app.sfx.play('lift');
  renderHud();
  return app.restartLog;
}

/** 静音：真挂起上下文；静音期间 play() 一个节点都不建（见 js/audio.js 的 blocked 计数）。 */
function toggleMute() {
  const st = app.sfx.toggleMute();
  renderHud();
  return st;
}

function toggleHelp() {
  app.helpOpen = !app.helpOpen;
  dom.helpPanel.hidden = !app.helpOpen;
  renderHud();
  return app.helpOpen;
}

/** 全屏绑在**真按钮** #btn-full 上；环境不给（沙箱、非安全上下文）就记下原因，不假装成功。 */
function toggleFullscreen() {
  const el = document.documentElement;
  const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
  try {
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit !== 'function') throw new Error('unsupported');
      app.swallowDom(exit.call(document));
      app.fullscreen = false;
    } else {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (typeof req !== 'function') throw new Error('unsupported');
      app.swallowDom(req.call(el));
      app.fullscreen = true;
    }
  } catch (e) {
    app.fullscreenError = String(e && e.message || e);
  }
  renderHud();
  return { on: app.fullscreen, error: app.fullscreenError || '' };
}
// requestFullscreen/exitFullscreen 返回 promise，被拦（非手势、iOS 不支持）会拒；
// 拒了不许冒成 unhandled rejection ⇒ 页面 console 干净也是出货的一部分。
app.swallowDom = (p) => { if (p && typeof p.catch === 'function') p.catch((e) => { app.fullscreenError = String(e && e.message || e); }); return p; };

/** 第一次真手势：建上下文（之前一个 AudioContext 都不建，autoplay 策略下那是白挨一条 warning）。 */
function unlockAudio() {
  if (app.unlocked) return true;
  app.unlocked = true;
  const ctx = app.sfx.arm();
  renderHud();
  return !!ctx;
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
  const fx = app.fx ? app.fx.stats() : null;
  const au = app.sfx.stats();
  lines.push(
    `手感层          ${fx ? `仿真 ${fx.clock.toFixed(3)}s / ${fx.simSteps} 步 · 粒子 ${fx.live} · 涟漪 ${fx.rings} · 链段 ${fx.links} · 流动 ${fx.flow.toFixed(2)} · 冻结 ${fx.frozen}${fx.reduced ? ' · 减少动效' : ''}` : '无画布'} ｜ 音频 上下文 ${au.contextOpen} · 音色 ${au.voices} · 静音挡下 ${au.blocked} · 未解锁拒放 ${au.deferred} · suspend ${au.suspendCalls}/resume ${au.resumeCalls}`,
  );
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
    app.sfx.play('wrong');
  } else {
    dom.status.textContent = `完成 · ${g.label} · 盘号 ${g.seed} · ${g.steps} 手 · ${g.hints} 次提示`;
    dom.verdict.textContent = `1..${g.n} 是一条王步相邻的链，且每个数各占一格 —— 全部 ${g.board.clueCount} 条题面数为真。` +
      `这盘的解被裁判穷举证明过唯一（${app.proof && app.proof.outcome}），所以你写出来的就是那一盘。`;
    dom.verdict.classList.add('ok');
    app.sfx.play('solve');
    const c = centerOf(g.sel);
    if (app.fx && c) app.fx.spawnBurst(c.x, c.y);
    renderHud();
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
  // 换一局 = 上一局的临时状态一律不清到新盘上（时钟/粒子/涟漪/链段几何）。
  if (app.fx) app.fx.reset();
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
app.view.onCell = (cell, src) => {
  const g = app.game;
  if (!g) return;
  if (app.paused) return;                 // 暂停态：点格子既不选中也不写子（sel/手数读数不动）
  // 一次点按 = pointerdown + click 两个事件。select 本身幂等，但音与涟漪不该来两遍，
  // 所以 pointerdown 记下令牌、下一帧清掉：click 撞上同一格的令牌就跳过。
  // 令牌不用时间戳 ⇒ 没有前置 pointerdown 的派发（键盘、el.click()）照常走完整通道。
  if (src !== 'pointer' && app.tapCell === cell) { app.tapCell = -1; return; }
  if (src === 'pointer') {
    app.tapCell = cell;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { app.tapCell = -1; });
  }
  unlockAudio();
  g.select(cell);                        // 交互模型只有一种：点格 = 选中
  app.sfx.play('tap');
  const c = centerOf(cell);
  if (app.fx && c) app.fx.spawnRing(c.x, c.y);
  app.lastHint = null;
  g.clearHint();
  paint();
  renderReadouts();
};
app.view.onNumber = (v) => {
  const g = app.game;
  if (!g) return;
  if (app.paused) return;
  unlockAudio();
  const res = g.press(v);
  if (!res.ok) {
    app.lastHint = { text: WHY[res.why] || `这一步没写进去（${res.why}）` };
    app.sfx.play('rub');
    paint();
    renderReadouts();
    return;
  }
  const c = centerOf(g.sel);
  const linkedNeighbour = (v > 1 && g.cellHolding(v - 1) >= 0) || (v < g.n && g.cellHolding(v + 1) >= 0);
  if (app.fx && c) app.fx.spawnPlace(c.x, c.y, linkedNeighbour);
  app.sfx.play('place');
  dom.verdict.hidden = true;
  afterMove();
  if (g.filled() === g.n) judgeAnswer();
};
function onKey(ev) {
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = ev.key;
  unlockAudio();                       // 键盘同样是真手势：按下第一下就该把上下文立起来
  // HUD 快捷键：五个动作键与屏幕上那排钮一一对应（同一个函数，不是两套实现）。
  if (k === 'p' || k === 'P') { ev.preventDefault(); setPaused(!app.paused); return; }
  if (k === 'r' || k === 'R') { ev.preventDefault(); restart(); return; }
  if (k === 'm' || k === 'M') { ev.preventDefault(); toggleMute(); return; }
  if (k === 'f' || k === 'F') { ev.preventDefault(); toggleFullscreen(); return; }
  if (k === 'h' || k === 'H') { ev.preventDefault(); toggleHelp(); return; }
  if (k === 'Enter' || k === ' ') {
    // 焦点在按钮上时**不许**抢：那是浏览器激活按钮的通道（Tab 到面板钮再按 Enter 落子那条腿靠它）。
    if (t && t.tagName === 'BUTTON') return;
    if (app.paused) { ev.preventDefault(); setPaused(false); }   // 只用来"继续"，不借用它落子
    return;
  }
  const g = app.game;
  if (!g) return;
  if (app.paused) return;                // 暂停态：玩法键一个都不响应（与盘上点选同一条闸）
  let moved = false, handled = true;
  if (k === 'ArrowLeft') { g.move(0, -1); moved = true; }
  else if (k === 'ArrowRight') { g.move(0, 1); moved = true; }
  else if (k === 'ArrowUp') { g.move(-1, 0); moved = true; }
  else if (k === 'ArrowDown') { g.move(1, 0); moved = true; }
  else if (k === '+' || k === '=') g.nudge(1);
  else if (k === '-' || k === '_') g.nudge(-1);
  else if (k === 'Backspace' || k === 'Delete') g.erase();
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
window.addEventListener('resize', () => { if (app.fx) app.fx.resize(); paint(); });
window.addEventListener('scroll', syncFx, { passive: true });   // 覆盖层是 fixed 的：滚了就得重新快照

// 特效层：dpr 由 fx.resize 换算（画布是 CSS 像素空间，position:fixed 不接指针）。
// reduceMotion 走**真分支**——系统开关中途改了要立刻换档，不是只在启动时读一次。
app.reduceMotionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
app.fx = new FxLayer(dom.fx, { seed: 0x48494441 });
app.fx.attach();
if (app.reduceMotionQuery) app.fx.setReduceMotion(!!app.reduceMotionQuery.matches);
app.fx.start();

// ── HUD 动作钮（每个都是真动作，aria-pressed 由 renderHud 回写）───────────────
dom.pause.addEventListener('click', () => { unlockAudio(); togglePause(); });
dom.restart.addEventListener('click', () => { unlockAudio(); restart(); });
dom.mute.addEventListener('click', () => { unlockAudio(); toggleMute(); });
dom.full.addEventListener('click', () => { unlockAudio(); toggleFullscreen(); });
dom.help.addEventListener('click', () => { unlockAudio(); toggleHelp(); });
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    app.fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    renderHud();
  });
}

// ── pointerdown 通道 ─────────────────────────────────────────────────────────
// 触屏上 click 要等 ~300ms 的判定窗口；这里用 pointerdown 立刻选中，坐标换算走
// getBoundingClientRect（CSS 像素，与覆盖层同一套坐标，不混 device 像素）。
// 随后的 click 会再选中同一个格 —— select 幂等，不产生第二手，读数不会翻倍。
dom.board.addEventListener('pointerdown', (ev) => {
  if (app.paused || !app.game) return;
  // 先看真命中盒（elementFromPoint），拿不到就逐格比视口矩形：
  // 均分矩形那种算法会把 gap/padding 算进格子里，边界上会命中错的一格。
  let cell = typeof document.elementFromPoint === 'function'
    ? app.view.cellFromPoint(ev.clientX, ev.clientY) : -1;
  if (cell < 0) {
    for (let c = 0; c < app.game.n; c++) {
      const r = app.view.cellRect(c);
      if (r && ev.clientX >= r.x && ev.clientX < r.x + r.w && ev.clientY >= r.y && ev.clientY < r.y + r.h) { cell = c; break; }
    }
  }
  if (cell >= 0 && cell < app.game.n) app.view.onCell(cell);
}, { passive: true });

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
  fx: app.fx,
  sfx: app.sfx,
  // 玩法态字符串：探针的 playFlag 靠它认"进没进关卡"。只写 playing / paused 两种取值
  //（paused 撞 MENUISH 是故意的：尺子看到暂停会自己走继续那条通道）。
  hud: { phase: 'playing' },
  /** 手动喂一段时间（三档对拍与阴性对照的入口；与 rAF 走同一个 pump ⇒ 同一条累加器）。 */
  update(dt) { return app.fx ? app.fx.pump(Number(dt) || 0) : 0; },
  stats() {
    return {
      fx: app.fx ? app.fx.stats() : null,
      audio: app.sfx.stats(),
      paused: app.paused ? 1 : 0,
      help: app.helpOpen ? 1 : 0,
      fullscreen: app.fullscreen ? 1 : 0,
      gesture: app.unlocked ? 1 : 0,
      reduced: app.fx ? app.fx.reduceMotion ? 1 : 0 : 0,
      restart: app.restartLog,
    };
  },
  pause: () => setPaused(true),
  resume: () => setPaused(false),
  togglePause,
  restart,
  toggleMute,
  toggleHelp,
  fullscreen: toggleFullscreen,
  unlockAudio,
  setReduceMotion(on) {
    if (!app.fx) return null;
    const v = app.fx.setReduceMotion(!!on);
    renderHud();
    return v;
  },
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
renderHud();
