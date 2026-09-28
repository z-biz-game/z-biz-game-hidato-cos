// 最小 CDP 驱动（需要 Node 22+：全局 WebSocket/fetch，零依赖）· 智渡 Hidato 浏览器闸
//
// env: CDP_PORT  devtools 端口，本仓 9401（端口表：root web 5401 / 前缀 web 5501 / CDP 9401）
//      BASE_URL  页面 origin，默认 http://127.0.0.1:5401/
//      NAV_URL   scenario/interact 的**导航 URL**（同源，可带查询串）；缺省 = BASE_URL
//                verify.sh 用它跑 ?tier=&seed= 那一形态
//      VIEWPORT  可选 "WxH"；设了就在**首次导航之前**覆盖 device metrics，一个页面一个 profile
//                既能按 1280×1024 量也能按 390×844 量，不需要窗口管理器
//      MAX_ROUNDS interact 的回合上限（默认 12）
//      SABOTAGE  闸的**阴性自证**开关（只对 witness / crossengine 的 node 侧期望生效）：
//                把期望指纹改错一位。绿不了的闸不是闸，这一条是验收第 4 项要求的自测旋钮，
//                它不参与任何判定、不放宽任何阈值 —— 它只用来证明"改错了会红"。
//
//   node tools/playtest.cjs open <url>              新开一个 tab，打印启动期 console
//   node tools/playtest.cjs eval '<expr>' [nonav]   求值（await promise），打印结果
//   node tools/playtest.cjs scenario <名> [json]    注入 tools/scenarios.js，跑 __scn.<名>()
//   node tools/playtest.cjs interact <名> [json]    同上，但走 **CDP 真指针 / 真按键 / 真刷新**多回合：
//                                                   页面交回 {pending:[{x,y}…]} ⇒ 本机用
//                                                   Input.dispatchMouseEvent 点下去；
//                                                   页面交回 {pendingKeys:[{key}…]} ⇒ 本机用
//                                                   Input.dispatchKeyEvent 按下去（键盘腿唯一通道）；
//                                                   页面交回 {reload:1} ⇒ 本机**先取刷新前证人**再 Page.reload
//                                                   （续局腿唯一通道；reload:'fragment:…' 只给阴性自证用）；
//                                                   页面交回 {carry:{…}} ⇒ 由 node 保管并在下一回合送回
//                                                   再回来跑下一回合
//   node tools/playtest.cjs witness <tier> <seed>   **node 侧证人**（不起 Chrome）：用浏览器加载的
//                                                   同一批 js/ 模块现算那张盘的出货指纹 / 真解 / 裁判读数
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// 三条本组织付过学费的口径，写在这个文件的行为里：
//   · **scenario/interact 每次都重新 navigate**，所以"跨刷新"的读数拿到的是一次真导航之后的新文档；
//     期望值走 argv（第二个参数）→ window.__expectRaw（**原样字符串**，场景里自己 JSON.parse），
//     **不走 URL 的 #expect=**：同一个文档里只换 fragment 不是导航，window.hidato 还在、存档根本没被读过。
//   · 选哪个页面 attach 由 BASE_URL 的 origin 决定，不写死端口：一个悄悄落在 about:blank 上的 eval
//     读起来像"部署坏了"，实际是门禁连错了对象。
//   · **指针腿走 CDP，不走 element.click()**：dispatchMouseEvent 产生的是浏览器自己的
//     mousedown/mouseup/click 序列，命中盒、事件目标、焦点都由 Chrome 决定 —— 这才叫"真指针"。
//     页面侧只允许交回坐标（它量到的 clientX/clientY），坐标到点击的这一步在 node 这边发生。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.CDP_PORT || 9401);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5401/';
const ORIGIN = new URL(BASE).origin;
const VIEWPORT = /^(\d+)x(\d+)$/.exec(process.env.VIEWPORT || '');
const SABOTAGE = process.env.SABOTAGE === '1';
// 阴性自证只改**一张盘**的期望：这样"红"落在具体那一档那一个 seed 上，而不是整批一起红 ——
// 整批红分不清是比对逻辑坏了还是期望没接上。
const SABOTAGE_SEED = process.env.SABOTAGE_SEED || '5x5/m0';
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];

/** 把串里第一个十六进制位翻掉：只给 SABOTAGE 的阴性自证用。 */
function breakOneDigit(s) {
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (/[0-9a-f]/i.test(str[i])) {
      const c = str[i];
      const next = String.fromCharCode(c.charCodeAt(0) + (/[0-8]/.test(c) ? 1 : -1));
      return str.slice(0, i) + next + str.slice(i + 1);
    }
  }
  return str + 'x';
}

// ── node 侧证人：import 的就是浏览器加载的那批 js/ 模块 ──────────────────────────────────
async function engine() {
  const gen = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'engine', 'generate.js')).href);
  const rules = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'engine', 'rules.js')).href);
  return { gen, rules };
}

/**
 * node 侧把一张盘算出来（与 js/ui/game.js 的 makeBoard 同一条出货路径、同一套 acc 观察者）。
 * 交回的 solution 是**真值**（v→格）：它只该出现在 node 侧与闸的期望值里，页面拿它当"要扫掉的东西"。
 */
async function nodeBoard(tierKey, seed) {
  const { gen, rules } = await engine();
  const watch = { calls: 0, maxMs: 0, maxNodes: 0, stoppedByNodes: 0, stoppedByMs: 0 };
  const acc = (r) => {
    watch.calls++;
    if (r.ms > watch.maxMs) watch.maxMs = r.ms;
    if (r.nodes > watch.maxNodes) watch.maxNodes = r.nodes;
    if (r.stopped) (r.stoppedBy === 'ms' ? watch.stoppedByMs++ : watch.stoppedByNodes++);
  };
  const out = gen.generate(tierKey, String(seed), { acc });
  const tier = gen.TIERS.find((t) => t.key === tierKey);
  const broken = SABOTAGE && `${tierKey}/${seed}` === SABOTAGE_SEED;
  if (!out.ok) {
    return {
      ok: false, tier: tierKey, seed: String(seed), fail: String(out.fail), draws: Number(out.draws) || 0,
      budgetMs: tier.budgetMs, nodeCap: tier.nodeCap, ...watch,
    };
  }
  const clues = rules.fromGivenCell(out.ship.given);
  return {
    ok: true,
    tier: tierKey,
    seed: String(seed),
    seedStr: out.seed,
    fingerprint: broken ? breakOneDigit(out.fingerprint) : String(out.fingerprint),
    fingerprintNode: String(out.fingerprint),
    n: tier.n, R: tier.R, C: tier.C,
    clueCount: clues.length,
    mine: tier.n - clues.length,
    clues,
    solution: Array.from(out.solution),
    budgetMs: tier.budgetMs,
    nodeCap: tier.nodeCap,
    ...watch,
  };
}

/**
 * 场景 C 的 node 半边：浏览器交回 18 组读数，这里对同一批 (tier,seed) 跑 generate() 逐条比指纹。
 * rows 与页面侧同形状（{test,pass,detail}），合进同一条 RESULT。
 */
async function crossEngineRows(samples) {
  const rows = [];
  const chromeMaxMs = [];
  const nodeMaxMs = [];
  let same = 0;
  let nodeMsCap = 0;
  let nodeCalls = 0;
  let callsDiff = 0;
  let nodesDiff = 0;
  const diffs = [];
  for (const s of samples) {
    const b = await nodeBoard(s.tier, s.seed);
    if (!b.ok) {
      rows.push({ test: `crossengine ${s.tier}/${s.seed} node 侧出货`, pass: false, detail: `fail=${b.fail}（浏览器却出了货 ⇒ 两侧不是同一条流水线）` });
      continue;
    }
    const eq = String(s.fingerprint) === String(b.fingerprint);
    if (eq) same++;
    else diffs.push(`${s.tier}/${s.seed} chrome=${s.fingerprint} 期望=${b.fingerprint}（node 实算 ${b.fingerprintNode}）`);
    chromeMaxMs.push(Number(s.refereeMaxMs) || 0);
    nodeMaxMs.push(Number(b.maxMs) || 0);
    nodeMsCap += b.stoppedByMs;
    nodeCalls += b.calls;
    const callsEq = Number(s.refereeCalls) === b.calls;
    const nodesEq = Number(s.refereeMaxNodes) === b.maxNodes;
    if (!callsEq) callsDiff++;
    if (!nodesEq) nodesDiff++;
    rows.push({
      test: `crossengine ${s.tier}/${s.seed} 出货盘指纹逐字节相同`,
      pass: eq && callsEq && nodesEq,
      detail: eq
        ? (callsEq && nodesEq ? '' : `裁判调用 ${s.refereeCalls} vs ${b.calls} · 单次最大节点 ${s.refereeMaxNodes} vs ${b.maxNodes}`)
        : `chrome=${s.fingerprint} 期望=${b.fingerprint}（node 实算 ${b.fingerprintNode}）· chromeMaxMs ${Number(s.refereeMaxMs || 0).toFixed(3)} / nodeMaxMs ${b.maxMs.toFixed(3)} · 预算 ${b.budgetMs} ms`,
    });
  }
  rows.push({
    test: `crossengine 出货盘指纹逐字节相同 ${same}/${samples.length}（跨引擎同一串 seed 同一张盘）`,
    pass: same === samples.length && samples.length > 0,
    detail: same === samples.length ? '' : `不一致 ${diffs.length} 张：${diffs.slice(0, 4).join(' | ')} · msCap 击穿 chrome ${samples.reduce((a, s) => a + (s.stoppedByMs || 0), 0)} / node ${nodeMsCap}（这等于这台机器改变了货，不是断言写错了）`,
  });
  rows.push({
    test: `crossengine ${samples.length} 张盘的 msCap 击穿两侧都是 0`,
    pass: nodeMsCap === 0 && samples.every((s) => !s.stoppedByMs),
    detail: `node 侧 msCap 击穿 ${nodeMsCap} 次 · Chrome 侧 ${samples.reduce((a, s) => a + (s.stoppedByMs || 0), 0)} 次（>0 就是这台机器改变了货）`,
  });
  const max = (a) => (a.length ? Math.max(...a) : 0);
  rows.push({
    test: `crossengine 裁判调用次数与单次最大节点数逐张相同（纯函数不随引擎变）`,
    pass: callsDiff === 0 && nodesDiff === 0,
    detail: `调用不同 ${callsDiff} 张 · 最大节点不同 ${nodesDiff} 张 · node 侧调用合计 ${nodeCalls}`,
  });
  return { rows, extra: { matched: same, nodeMsCap, chromeMaxMs: max(chromeMaxMs), nodeMaxMs: max(nodeMaxMs) } };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  // witness 这一腿不连 Chrome：它是"页面读数的对照组"，必须先能独立跑起来。
  if (cmd === 'witness') {
    const b = await nodeBoard(arg, rest);
    console.log(JSON.stringify(b));
    process.exit(0);
  }

  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  if (VIEWPORT) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Number(VIEWPORT[1]),
      height: Number(VIEWPORT[2]),
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
  }

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  /** 一次 CDP 真指针点击：move → press → release，坐标就是页面量到的 clientX/clientY。 */
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
  };

  /**
   * key 名 → CDP 需要的 code / 虚拟键码 / text。走的是 Chrome 自己那套 WebKitKeyboardCodes，
   * 派发进来的事件 isTrusted=true、target = document.activeElement —— 这才叫**真键盘通道**：
   * 页面的 INPUT/SELECT 守卫读的是 ev.target，而 ev.target 由浏览器的焦点系统决定，不由测试决定。
   */
  const KEYDESCRIPTOR = {
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    '=': { code: 'Equal', vk: 187, text: '=' },
    '+': { code: 'Equal', vk: 187, text: '+', modifiers: 8 },        // Shift+＝ ⇒ key '+'
    '-': { code: 'Minus', vk: 189, text: '-' },
    _: { code: 'Minus', vk: 189, text: '_', modifiers: 8 },
    Backspace: { code: 'Backspace', vk: 8 },
    Delete: { code: 'Delete', vk: 46 },
  };

  /** 一次 CDP 真按键：keyDown（可打印键带 text，浏览器自己补 char/输入）+ keyUp。
   *  未知键名直接抛：静默少派一个键就是假绿。 */
  const pressKey = async (name) => {
    const d = KEYDESCRIPTOR[name];
    if (!d) throw new Error(`键盘腿要派的键不在表里：${JSON.stringify(name)}`);
    const base = { key: name, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
    if (d.modifiers) base.modifiers = d.modifiers;
    const txt = d.text ? { text: d.text } : {};
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...txt }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  };

  /**
   * 续局腿的**刷新前证人**：node 在派发 Page.reload **之前**自己跑一次 Runtime.evaluate。
   * 只有 node 手里有这份东西，刷新后场景才可能拿到"不是这个文档给的"值 —— 同文档片段跳转冒充重载
   * 那一类假绿就死在这一句上（页面自己报的读数它也能报对，node 取的这份它报不出新的 timeOrigin）。
   * 顺手把哨兵串设进旧上下文：新文档里读不到它 = JS 上下文真的换了。
   */
  const SENTINEL = '__hidatoPreReloadSentinel';
  const preReloadWitness = async () => {
    const raw = await evaluate(`(() => {
      window.${SENTINEL} = ${JSON.stringify('hidato-verify-pre-reload')};
      const s = window.hidato && window.hidato.state ? window.hidato.state() : null;
      if (!s) throw new Error('刷新前证人取不到：window.hidato.state() 是空的');
      return JSON.stringify({
        sentinel: window.${SENTINEL},
        timeOrigin: String(performance.timeOrigin),
        href: location.href,
        docTimeOrigin: String(window.hidato.doc.timeOrigin),
        tier: s.tier, seed: s.seed, entries: s.entries, steps: s.steps, hints: s.hints,
        selected: s.selected, fingerprint: s.fingerprint, mine: s.counts.mine, clueCount: s.clueCount,
      });
    })()`);
    return JSON.parse(raw);
  };

  /** 一次**真**刷新：Page.reload + 等文档重新 complete + 重新上膛（新文档的 window 是空的）。 */
  const reloadDocument = async () => {
    await cdp.send('Page.reload', { ignoreCache: false }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
    await arm();
  };

  const install = async () => {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await navigate(process.env.NAV_URL || BASE);
    await arm();
  };

  /**
   * 每次导航之后重新上膛：headless 会把页面报成 hidden，等重绘的场景就会对着一个假装在后台的 tab 超时；
   * 期望值走 window.__expectRaw（原样字符串），场景里自己 JSON.parse。
   * **续局腿刷新之后也要走这里**：新文档的 window 是空的，__expectRaw 不上膛就没有期望值。
   */
  const arm = async () => {
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});
      window.__expectRaw = ${JSON.stringify(rest || 'null')}; 'ok'`);
  };

  const call = (name, roundArg) => `(async()=>{
      if (!window.__scn) throw new Error('scenarios.js never installed');
      const fn = window.__scn[${JSON.stringify(name)}];
      if (typeof fn !== 'function') {
        throw new Error('没有这个场景：' + ${JSON.stringify(name)} + '（已注册：' + Object.keys(window.__scn).join(',') + '）');
      }
      const r = await fn(${roundArg || 'undefined'});
      return JSON.stringify(r);
    })()`;

  /** 页面交回的行 + 需要时才跑的 node 证人，合成一条 RESULT 打在最后。 */
  const emit = async (out) => {
    const parsed = JSON.parse(out);
    if (parsed && parsed.nodeWitness === 'crossEngineFingerprints') {
      const samples = parsed.samples || [];
      const { rows, extra } = await crossEngineRows(samples);
      const all = (parsed.rows || []).concat(rows);
      parsed.rows = all;
      parsed.fail = all.filter((r) => !r.pass).length;
      parsed.chromeMaxMs = Number((samples.length ? Math.max(...samples.map((s) => Number(s.refereeMaxMs) || 0)) : 0).toFixed(3));
      parsed.nodeMaxMs = Number(extra.nodeMaxMs.toFixed(3));
      parsed.budgetMs = samples.length ? (await nodeBoard(samples[0].tier, samples[0].seed)).budgetMs : null;
      parsed.msCapChrome = samples.reduce((a, s) => a + (s.stoppedByMs || 0), 0);
      parsed.msCapNode = extra.nodeMsCap;
      parsed.matched = `${extra.matched}/${samples.length}`;
      delete parsed.samples;                      // 18 组原文回给报告就够了，别塞进 RESULT 行
    }
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + JSON.stringify(parsed));
  };

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    await install();
    await emit(await evaluate(call(arg)));
  } else if (cmd === 'interact') {
    await install();
    const max = Number(process.env.MAX_ROUNDS || 12);
    let final = null;
    let carry = null;                     // 页面交回、**node 保管**、下一回合再送回去的东西（续局的证人就走这条路）
    let keptRows = [];                    // 刷新**前**那几回合的断言：旧文档一死页内数组就没了，靠 node 兜住
    for (let round = 0; round < max; round++) {
      const ctxParts = [`round:${round}`];
      if (carry !== null) ctxParts.push(`carry:${JSON.stringify(carry)}`);
      final = JSON.parse(await evaluate(call(arg, `{${ctxParts.join(',')}}`)));
      if (final.carry) carry = Object.assign({}, carry || {}, final.carry);
      const pending = final && final.pending;
      const keys = final && final.pendingKeys;
      if (final && final.reload) {
        if (Array.isArray(final.rows)) keptRows = keptRows.concat(final.rows);   // 交回来的断言先收下再刷新
        // 刷新**之前**先在旧上下文里取证人（node 自己取的那一份，页面再也报不出第二个 timeOrigin）
        const pre = await preReloadWitness();
        carry = Object.assign({}, carry || {}, {
          pre, pageReported: final.pre || null,
          reloadMode: typeof final.reload === 'string' ? 'fragment-sabotage' : 'page-reload',
        });
        if (typeof final.reload === 'string' && final.reload.startsWith('fragment:')) {
          // 阴性自证专用：**同文档**片段导航（不是导航：window 还在、store.load() 一次都没跑）。
          // 真的续局腿绝不该走到这一支；走到就是让场景那条"新文档"证人当场红。
          await evaluate(`location.href = ${JSON.stringify(final.reload.slice('fragment:'.length))}`);
          await sleep(200);
        } else {
          await reloadDocument();
        }
        continue;
      }
      if (keys && keys.length) {
        for (const k of keys) await pressKey(String(k && k.key));
        await sleep(60);                  // 让 keydown 处理与重画落地，再谈下一回合的读数
        final.pendingKeysCount = (final.pendingKeysCount || 0) + keys.length;
        continue;
      }
      if (!pending || !pending.length) break;
      for (const p of pending) await clickAt(Number(p.x), Number(p.y));
      await sleep(80);                       // 让 click 处理与重画落地，再谈下一回合的读数
      final.pendingCount = (final.pendingCount || 0) + pending.length;
    }
    if (!final) throw new Error('interact 一个回合都没跑成');
    if (final.pending && final.pending.length) throw new Error(`interact 超过 ${max} 回合还没走完（还欠 ${final.pending.length} 次点击）`);
    if (final.pendingKeys && final.pendingKeys.length) throw new Error(`interact 超过 ${max} 回合还没走完（还欠 ${final.pendingKeys.length} 次按键）`);
    if (final.reload) throw new Error(`interact 超过 ${max} 回合还没走完（刷新那一步没走到）`);
    // 把刷新前那几回合的断言并回来：条数是这条腿的一部分，掉了文档不能跟着掉。
    final.rows = keptRows.concat(final.rows || []);
    final.fail = final.rows.filter((r) => !r.pass).length;
    await emit(JSON.stringify(final));
  } else if (cmd === 'shot') {
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
