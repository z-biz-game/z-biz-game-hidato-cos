// 浏览器闸跑在页面里的场景：注入后由 tools/playtest.cjs 的 `scenario|interact <名>` 调 window.__scn.<名>()。
//
// 本回合七条腿（简报的验收合同；verify.sh 的清单里 boot 跑两种 URL ⇒ 共八段）：
//   · boot        场景 A · 启动与"页面里没有答案"（含 URL 定盘、msCap=0 证人、真值扫描）
//   · crossengine 场景 C · 18 张出货盘的**跨引擎指纹对账**（页侧收集，node 侧逐条比）
//   · pointer     场景 B · CDP 真指针把一张 5×5 走完（多回合：页面交坐标，node 去点）
//   · keyboard    场景 D · **真键盘通道**（CDP Input.dispatchKeyEvent；页面一个 hidato.press() 都不调）
//   · resume      场景 E · 跨**真刷新**续玩（Page.reload；刷新前证人由 node 取走再送回来）
//   · narrow      场景 F · **窄屏腿**：视口/dpr 覆写发生在这一腿自己的那次调用里（attach 后、导航前），
//                  再把 innerWidth/innerHeight/devicePixelRatio/clientWidth 读回来自证，逐格量命中盒
//   · canary      场景 G · **拒盘腿**：五张 node 算好的负样本灌进 gate.loadBoard，逐条证明页面的
//                  拒绝分支（铅笔推不完 / nodeCap 掐停 / count!==1 / given-adjacency / 端点没印全）
//                  在浏览器里到得了；stopped 那张只用 nodeCap 造，绝不碰 msCap
// 判定用的读数一律留在 stdout 里；墙上时钟那类（timeOrigin / 耗时 / 需要滚动几个控件）以 `_`前缀
// 交回——它们进 .extra.json 供复验，但不进可 diff 的那条通道，否则"连跑两次逐字节相同"永远做不到。
//
// 规矩与兄弟仓同名同姓，内容是本仓自己的：
//   * 一条断言只写一次 `ck(名, 条件, 细节)`，机器可读的 `RESULT <json>` 由 playtest.cjs 打在 stdout
//     最后一行；一条断言都没发生的场景在 tools/verify.sh 里直接判红；
//   * **期望值来自 node**：真解、出货盘指纹、题面条数、裁判调用数全部由 `node tools/playtest.cjs
//     witness <tier> <seed>` 现算（它 import 的就是浏览器加载的那批 js/ 模块），经 argv →
//     window.__expectRaw 传进来。页内不许自己"跟自己的上一版对表"，也不许把真解算出来再抄：
//     真值只以"要被扫掉的东西"这个身份进页面；
//   * 指针腿走 **CDP Input.dispatchMouseEvent**（tools/playtest.cjs 的 interact），页面只交坐标；
//     不用 element.click() —— 那等于没测命中盒与事件目标；
//   * 出货盘指纹 = generate(tier,seed).fingerprint（js/engine/generate.js 里那个 FNV）。
//     tools/port-check.mjs 第 36 列比的是**证书盘**certFingerprint，两者不是同一个串，别混。
//
// 这一段跑在 js/main.js **之前**（Page.addScriptToEvaluateOnNewDocument），所以启动期的未捕获异常
// 与资源 404 抓得到：那是"浏览器闸要抓的第一类 bug"，页面自己永远打印不出来。
((w) => {
  // ---------------------------------------------------------------- 探针：启动期的错与 404
  const PROBE = { js: [], res: [] };
  w.__probe = PROBE;
  w.addEventListener('error', (ev) => {
    const t = ev && ev.target;
    if (t && t !== w && (t.tagName || t.src || t.href)) {
      PROBE.res.push(`${t.tagName || 'node'}:${t.src || t.href || ''}`);
    } else {
      PROBE.js.push(String((ev && (ev.message || ev.error)) || 'error'));
    }
  }, true);
  w.addEventListener('unhandledrejection', (ev) => PROBE.js.push('rejection: ' + String(ev.reason)));
  const realError = w.console.error;
  w.console.error = function () {
    PROBE.js.push('[console.error] ' + [].map.call(arguments, String).join(' '));
    return realError.apply(this, arguments);
  };

  // ---------------------------------------------------------------- 断言小台
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * 把已经攒下的断言**交回 node 保管**并清空。续局腿非用不可：Page.reload 之后这是一个新文档，
   * 模块级 `rows` 数组跟着旧文档一起没了 —— 不交回来的话刷新前那两回合的断言就凭空蒸发，
   * tally 里只剩刷新后的读数，那条腿就变成"只验了后半截"。
   */
  const drain = () => { const o = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length }; rows.length = 0; return o; };
  const $ = (sel) => document.querySelector(sel);
  const H = () => w.hidato;
  const D = () => w.hidato.dom;
  const S = () => w.hidato.state();
  const text = (node) => ((node || {}).textContent || '');
  const exp = () => JSON.parse(w.__expectRaw || 'null');

  /**
   * 动态 import 必须按 document.baseURI 解析：Pages 把本仓挂在 /<repo>/ 下，斜杠开头的说明符会解到
   * 域名根上 404（本地"根形态"跑起来一切正常 —— 最坏的那种绿）。
   */
  const mod = (rel) => import(new URL(rel, document.baseURI).href);

  const shown = (node) => {
    const e = typeof node === 'string' ? $(node) : node;
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  /** [hidden] 的兄弟仓踩过：元素自带 display:grid/flex 会盖过 UA 那条 [hidden]{display:none}。 */
  const hiddenTight = (node) => {
    const e = typeof node === 'string' ? $(node) : node;
    return !!e && e.hidden && getComputedStyle(e).display === 'none' && e.getClientRects().length === 0;
  };
  const whyNotTight = (node) => {
    const e = typeof node === 'string' ? $(node) : node;
    if (!e) return '节点不存在';
    return `hidden=${e.hidden} display=${getComputedStyle(e).display} rects=${e.getClientRects().length}`;
  };
  /** 命中盒：中心点在视口内、且 elementFromPoint 落回自己（或自己的后代）。 */
  const hitSelf = (el) => {
    if (!el) return '控件不存在';
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return '零尺寸';
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > w.innerWidth + 0.5 || y > w.innerHeight + 0.5) {
      return `中心在视口外 ${Math.round(x)},${Math.round(y)}（视口 ${w.innerWidth}×${w.innerHeight}）`;
    }
    const hit = document.elementFromPoint(x, y);
    if (hit === el || el.contains(hit) || (hit && hit.contains(el))) return '';
    return `中心被 ${hit ? (hit.id || hit.className || hit.tagName) : 'nothing'} 盖住`;
  };
  /** 该藏起来的东西不能被命中到：elementFromPoint 落在它身上 = 只是"看不见"却还能点。 */
  const unhittable = (el) => {
    if (!el) return '节点不存在';
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit) ? `elementFromPoint 还能命中它（${hit.tagName}）` : '';
  };
  const centerOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // ---------------------------------------------------------------- 收据解析
  /** 从 #receipt 那一段人读文本里把预算证人抠出来（文案改了这里就该红，不是静默少一条断言）。 */
  const receiptWitness = () => {
    const t = text(D().receipt);
    const ref = /裁判开销\s+(\d+) 次调用 · 单次最大 ([\d.]+) ms \/ (\d+) 节点（预算 (\d+) ms \/ (\d+) 节点）/.exec(t);
    const breach = /预算击穿\s+nodes (\d+) 次 · ms (\d+) 次/.exec(t);
    const fp = /指纹\s+([0-9a-f]+)（出货盘/.exec(t);
    const cert = /证书盘 ([0-9a-f]+|null)（port-check/.exec(t);
    return {
      parsed: !!(ref && breach && fp),
      calls: ref ? Number(ref[1]) : null, maxMs: ref ? Number(ref[2]) : null,
      maxNodes: ref ? Number(ref[3]) : null, budgetMs: ref ? Number(ref[4]) : null, budgetNodes: ref ? Number(ref[5]) : null,
      breachNodes: breach ? Number(breach[1]) : null, breachMs: breach ? Number(breach[2]) : null,
      fingerprint: fp ? fp[1] : null, certFingerprint: cert ? cert[1] : null,
    };
  };

  // ---------------------------------------------------------------- 真值扫描（场景 A 的主干）
  /**
   * 扫三处：window.hidato 的对象图（含 app/game/view/dom/proof，连类原型上的方法名一起）、
   * 所有 DOM 元素的属性名与属性值、localStorage 的全键全值。
   * 命中判据两条：**真值本身**（node 侧算出的 v→格序列，数组或串）与**答案味的字段名**。
   * 字段名这一条有一个显式白名单：window.hidato.dom 是 DOM 句柄表（简报自己把它列为要 BFS 的一支），
   * 它命中 /dom\b/ 但不携带任何真值 —— 白名单之外一个都不许留，且白名单本身要能被证伪。
   * 函数的**声明名**另记一支（fnHits）：它不是"字段名"，所以不进 hitsKey，但必须被打印并钉成清单。
   */
  const answerScan = async (E) => {
    const store = await mod('./js/store.js');
    const NAMEISH = /(truth|solution|answer|cellOf|assign|pos\b|dom\b)/i;      // 简报那张表
    const sol = E.solution.slice();                                           // 长度 n+1：[v]=格，[0]=-1
    const n = E.n;
    const byCell = new Array(n).fill(-1);
    for (let v = 1; v <= n; v++) byCell[sol[v]] = v;
    const seqStr = sol.slice(1).map((c, i) => `s${i + 1}:${c}`).join('');      // 指纹原像里的真值那一段
    const forms = [sol.join(','), sol.slice(1).join(','), byCell.join(','), byCell.join('|'), seqStr];
    const hitsStr = [];
    const hitsKey = [];
    const hitsArr = [];
    const fnHits = [];
    const allowed = [];
    const strHit = (s) => {
      if (typeof s !== 'string' || !s) return null;
      for (let i = 0; i < forms.length; i++) if (s.indexOf(forms[i]) >= 0) return i;
      return null;
    };
    const tagged = (v) => Object.prototype.toString.call(v).slice(8, -1);
    const isArr = (v) => !!v && typeof v === 'object' && (Array.isArray(v) || /^(Int8|Uint8|Uint16|Int32|Uint32|Float32|Float64)Array$/.test(tagged(v)));
    const sameAs = (a, want) => a.length === want.length && a.every((v, i) => Number(v) === Number(want[i]));
    let nodes = 0;
    const seen = new Set();
    const queue = [[H(), 'hidato']];
    while (queue.length && nodes < 9000) {
      const [o, path] = queue.shift();
      if (!o || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) continue;
      seen.add(o);
      nodes++;
      if (o instanceof Node || o instanceof Window) continue;                 // DOM 那一支由下面的属性扫描负责
      if (typeof o === 'function') { if (NAMEISH.test(o.name || '')) fnHits.push(`${path}()`); continue; }
      if (isArr(o)) {
        const a = Array.prototype.slice.call(o);
        if (sameAs(a, sol) || sameAs(a, byCell)) hitsArr.push(path);
      }
      let keys = [];
      try { keys = Object.keys(o); } catch { continue; }
      for (const k of keys) {
        const at = `${path}.${k}`;
        let v;
        try { v = o[k]; } catch { continue; }
        if (NAMEISH.test(k)) {
          if (at === 'hidato.dom' && v && typeof v === 'object' &&
              Object.keys(v).length > 0 && Object.values(v).every((x) => !x || x instanceof Node || typeof x === 'function')) {
            allowed.push(at);                                                  // DOM 句柄表：不含真值，见上面的值判据
          } else hitsKey.push(at);
        }
        const hit = strHit(typeof v === 'string' ? v : null);
        if (hit !== null) hitsStr.push(`${at}[form ${hit}]`);
        if (v && (typeof v === 'object' || typeof v === 'function') && !(v instanceof Node)) queue.push([v, at]);
      }
    }
    // 类原型上的方法名也算对象图：`solution()` / `cellOf()` 这种通道同样不该存在。
    const protos = [];
    if (H().game) protos.push(['game@' + (H().game.constructor && H().game.constructor.name), Object.getPrototypeOf(H().game)]);
    protos.push(['view@BoardView', Object.getPrototypeOf(H().view)]);
    for (const [nm, p] of protos) {
      if (!p) continue;
      for (const k of Object.getOwnPropertyNames(p)) if (NAMEISH.test(k)) hitsKey.push(`${nm}.${k}`);
    }
    // DOM：属性名与属性值
    let domNodes = 0;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      domNodes++;
      for (const a of Array.from(el.attributes || [])) {
        if (NAMEISH.test(a.name)) hitsKey.push(`dom<${el.tagName}#${el.id}>@${a.name}`);
        const hit = strHit(a.value);
        if (hit !== null) hitsStr.push(`dom<${el.tagName}#${el.id}>@${a.name}[form ${hit}]`);
      }
    }
    // localStorage：全键全值 + 存档字段白名单
    const lsKeys = Object.keys(localStorage);
    const saveFields = [];
    let hitsLs = [];
    for (const k of lsKeys) {
      const v = localStorage.getItem(k);
      const hit = strHit(v);
      if (hit !== null) hitsLs.push(`${k}[form ${hit}]`);
      if (NAMEISH.test(k)) hitsLs.push(`${k}(键名)`);
      if (k === store.SAVE_KEY) {
        try { saveFields.push(...Object.keys(JSON.parse(v))); } catch { saveFields.push('<读不开>'); }
      }
    }
    return {
      nodes, domNodes, hitsArr, hitsKey, hitsStr, hitsLs, lsKeys, saveFields, allowed, fnHits,
      allow: store.SAVE_FIELDS.slice(), saveKey: store.SAVE_KEY,
      answerishSeen: store.ANSWERISH.source,
    };
  };

  // ================================================================ 场景 A · boot 与"页面里没有答案"
  const boot = async () => {
    const E = exp();
    ck('期望值由 node 侧证人交回（witness 那一腿起不来就必须红）', !!E && E.ok === true, w.__expectRaw);
    if (!E || !E.ok) return report({ href: location.href });
    ck('启动期没有未捕获异常 / 资源 404（含 node: 说明符这种浏览器解不开的 import）',
      PROBE.js.length === 0 && PROBE.res.length === 0, JSON.stringify(PROBE).slice(0, 420));
    ck('window.hidato 在场且版本是 2.0.0', !!H() && H().version === '2.0.0', H() && H().version);
    const st = S();
    ck('state() 交回一张盘（open 成功回的是 summary，别把成功读成失败）', !!st, 'null');
    if (!st) return report({ href: location.href });

    eq('档位是 node 证人那一个', st.tier, E.tier);
    eq('盘号原样被用（不是日期算出来的）', st.seed, E.seed);
    eq('seed 串形状 hidato|档位|盘号', st.seedStr, E.seedStr);
    eq('出货盘指纹 = node 侧 generate().fingerprint（逐字节）', st.fingerprint, E.fingerprint);
    eq('题面条数 = node 侧', st.clueCount, E.clueCount);
    ck('这一盘通过了页面自己的验收（state().proven === true）', st.proven === true, JSON.stringify(st.proof).slice(0, 300));
    ck('#board-wrap 的 hidden 是 false 且真的在屏上',
      D().boardWrap.hidden === false && shown('#board-wrap'), whyNotTight('#board-wrap') + ' hidden=' + D().boardWrap.hidden);
    ck('#reject 起步是**真**隐藏（display:none 且 0 个 rect）', hiddenTight('#reject'), whyNotTight('#reject'));
    ck('#verdict 起步是**真**隐藏', hiddenTight('#verdict'), whyNotTight('#verdict'));
    ck('#reject-detail 是空的', text(D().rejectDetail) === '', text(D().rejectDetail).slice(0, 120));
    ck('藏起来的 #reject / #verdict 也点不到（elementFromPoint 不落在它们身上）',
      [$('#reject'), $('#verdict')].every((el) => unhittable(el) === ''),
      [$('#reject'), $('#verdict')].map((el) => unhittable(el)).filter(Boolean).join(' · '));
    ck('状态条写着已出货', text(D().status).indexOf('已出货') === 0, text(D().status));
    eq('档位选择器与盘号输入框跟着首屏盘', `${D().tier.value}/${D().seed.value}`, `${E.tier}/${E.seed}`);
    const given = E.clueCount;
    eq('#stat-filled 的读数 = 印着的条数 + 你写 0',
      text(D().filled).replace(/\s+/g, ' '), `已填 ${given}/${E.n}（印着 ${given} · 你写 0）`);
    eq('counts.filled / given / mine / empty', `${st.counts.filled}/${st.counts.given}/${st.counts.mine}/${st.counts.empty}`,
      `${given}/${given}/0/${E.mine}`);
    eq('起步 0 手 / 0 次提示 / 0 冲突', `${st.steps}/${st.hints}/${st.conflicts}`, '0/0/0');
    eq('玩家的手（entries）全 00（题面不落进存档）', st.entries, '00'.repeat(E.n));
    ck('1、n 两个端点印在盘上（Hidato 的题面形状）',
      (() => { const g = {}; for (const c of E.clues) g[c.v] = c.cell; return g[1] >= 0 && g[E.n] >= 0; })(), true);

    // URL 定盘：?tier=&seed= 决定首屏（boot.requested 是页面自己记的那一条优先级链）
    const b = H().boot || {};
    eq('boot.requested = node 证人那一张（URL > 存档 > 默认）', `${b.requested?.tier}/${b.requested?.seed}`, `${E.tier}/${E.seed}`);
    const q = new URLSearchParams(location.search);
    if (q.get('tier') || q.get('seed')) {
      ck('URL 带的 ?tier=&seed= 被原样用（不是"恰好默认值"）',
        q.get('tier') === E.tier && q.get('seed') === E.seed && b.resumed === false,
        `href=${location.href} resumed=${b.resumed}`);
    } else {
      ck('没有查询串时走默认档 + 默认盘号（5x5 / h0）', E.tier === '5x5' && E.seed === 'h0', `${E.tier}/${E.seed}`);
      ck('新 profile 上无档可续（hasSaveAtBoot=false 且没续局）',
        b.hasSaveAtBoot === false && b.resumed === false, JSON.stringify(b));
    }

    // 预算证人：页面打印的那一行必须与 node 侧同读数，且 **msCap 击穿 = 0**
    const rw = receiptWitness();
    ck('#receipt 里那两行预算证人解析得开（文案漂了就红，不许静默少断言）', rw.parsed, JSON.stringify(rw));
    if (rw.parsed) {
      const p = st.proof || {};
      eq('收据的裁判调用次数 = state().proof = node 侧', `${rw.calls}/${p.refereeCalls}`, `${E.calls}/${E.calls}`);
      eq('收据的单次最大节点数 = state().proof = node 侧（纯函数不随引擎变）',
        `${rw.maxNodes}/${p.refereeMaxNodes}`, `${E.maxNodes}/${E.maxNodes}`);
      eq('收据写的预算 = 档位表（budgetMs / nodeCap）', `${rw.budgetMs}/${rw.budgetNodes}`, `${E.budgetMs}/${E.nodeCap}`);
      eq('页面打印的 msCap 击穿次数必须是 0（>0 ⇒ 同一串在快慢机器上是两张盘）', rw.breachMs, 0);
      eq('state().proof.stoppedByMs 与收据那一行同读数', `${p.stoppedByMs}/${rw.breachMs}`, `0/0`);
      eq('nodeCap 击穿次数：页面 = node 侧（允许 >0，方向安全）', `${rw.breachNodes}/${p.stoppedByNodes}`, `${E.stoppedByNodes}/${E.stoppedByNodes}`);
      eq('收据那行的出货盘指纹 = state().fingerprint = node 侧', `${rw.fingerprint}/${st.fingerprint}`, `${E.fingerprint}/${E.fingerprint}`);
      ck('收据分清两个指纹（出货盘 vs 证书盘不是同一个串）',
        !!rw.certFingerprint && rw.certFingerprint !== rw.fingerprint, `出货 ${rw.fingerprint} / 证书 ${rw.certFingerprint}`);
    }
    const note = text(D().saveNote);
    ck('#save-note 写着存档键名与六键白名单（在句首，用户 Ctrl-F 也命中）',
      note.indexOf('hidato.save.v1') === 0 && note.indexOf('tier/seed/entries/steps/hints') > 0, note.slice(0, 160));

    // 阴性自证（PLANT_TRUTH=1 时 verify.sh 在期望里带 plant:1）：把 node 侧真值**当场种进对象图**，
    // 让扫描必须抓到它 —— 一条永远为空的扫描和一条永不击中的闸是同一种废铁。抓不到就是这条红。
    let planted = null;
    if (E.plant === 1) {
      planted = { solution: E.solution.slice() };
      H().gate.__plantedTruth = planted;
    }
    const scan = await answerScan(E);
    if (planted) {
      delete H().gate.__plantedTruth;
      ck('阴性自证：种进对象图的真值被扫描抓到（抓到才会走到上面几条红）',
        scan.hitsArr.length + scan.hitsKey.length + scan.hitsStr.length > 0,
        `arr=${JSON.stringify(scan.hitsArr)} key=${JSON.stringify(scan.hitsKey)}`);
    }
    ck(`window.hidato 对象图（BFS ${scan.nodes} 个节点，含类原型方法名）里扫不到真值数组`,
      scan.hitsArr.length === 0, scan.hitsArr.join(' '));
    ck('对象图 / DOM 属性值 / localStorage 里扫不到真值串（v→格四种拼法）',
      scan.hitsStr.length === 0, scan.hitsStr.slice(0, 6).join(' '));
    ck('页面对象图里没有答案味的字段名（白名单只有 hidato.dom 这一个 DOM 句柄）',
      scan.hitsKey.length === 0, scan.hitsKey.join(' '));
    // 函数**声明名**不是简报里说的"字段名"：挂在 hidato.judge 上的那个函数在 js/main.js 里叫 judgeAnswer，
    // 它只把玩家自己写的编号交给 rules.verifyNumbering，不携带任何真值。这一条不放宽字段名断言，
    // 而是把答案味的函数名钉成一张已登记的清单 —— 多一个新名字就红。
    ck('答案味的函数名只出现在登记过的那一个动词上（hidato.judge ⇒ js/main.js 的 judgeAnswer）',
      scan.fnHits.join(' ') === 'hidato.judge()', `函数名命中 ${JSON.stringify(scan.fnHits)}`);
    ck('DOM 属性名里没有答案味字段（扫了 ' + scan.domNodes + ' 个元素）',
      scan.hitsKey.every((h) => h.indexOf('dom<') !== 0), scan.hitsKey.filter((h) => h.indexOf('dom<') === 0).join(' '));
    ck(`localStorage 只有 ${scan.saveKey} 一个键，值里没有真值`,
      scan.lsKeys.length === 1 && scan.lsKeys[0] === scan.saveKey && scan.hitsLs.length === 0,
      `${JSON.stringify(scan.lsKeys)} ${scan.hitsLs.join(' ')}`);
    ck('存档 JSON 的字段名 ⊂ 白名单（多一个键就红）',
      scan.saveFields.length > 0 && scan.saveFields.every((f) => scan.allow.indexOf(f) >= 0),
      `在档 ${JSON.stringify(scan.saveFields)} / 白名单 ${JSON.stringify(scan.allow)}`);
    ck('js/store.js 的 ANSWERISH 仍覆盖闸用的那几个名字（守卫没被悄悄削窄）',
      ['truth', 'solution', 'answer', 'pos', 'assign', 'dom'].every((k) => new RegExp(scan.answerishSeen, 'i').test(k)),
      scan.answerishSeen);
    ck('扫描真的覆盖到了对象图（节点数 > 60 且 DOM 元素数 > 60）',
      scan.nodes > 60 && scan.domNodes > 60, `bfs=${scan.nodes} dom=${scan.domNodes}`);
    ck('白名单被命中时只命中了那一个 DOM 句柄（不是"整张表都是答案"）',
      scan.allowed.every((a) => a === 'hidato.dom') && scan.allowed.length <= 1, JSON.stringify(scan.allowed));

    return report({
      shape: location.href, href: location.href, baseURI: document.baseURI,
      tier: st.tier, seed: st.seed, fingerprint: st.fingerprint,
      // 下面三个是**墙上时钟读数**（文档的 timeOrigin、裁判耗时、node 侧耗时），不参与任何判定：
      // 判定用的是 msCapBreaches（击穿次数，恒为 0 才是绿）与上面那几条扫描行。
      // 与 resume 腿的 _timeOriginBefore/After、窄屏腿的 _scrollHeight 同一处理：留在 .extra.json 供复验，
      // 不进 stdout —— 否则"同一条命令连跑两次逐字节 diff 为空"这一条判据永远做不到。
      _timeOrigin: H().doc.timeOrigin, bfsNodes: scan.nodes, domNodes: scan.domNodes,
      domHandleWhitelist: scan.allowed,
      _chromeRefereeMaxMs: st.proof ? Number(st.proof.refereeMaxMs.toFixed(3)) : null,
      _nodeRefereeMaxMs: Number(E.maxMs.toFixed(3)), budgetMs: E.budgetMs, msCapBreaches: rw.breachMs,
    });
  };

  // ============================================================ 场景 C · 跨引擎出货盘指纹对账
  /**
   * 本仓最硬的一条：**同一串 seed 在 Chrome 里与在 node 里必须是同一张盘**。
   * 页侧只负责把 18 张盘的读数收齐（open 成功时回的是 summary，里面没有 ok 字段 ⇒ 成败看 state()），
   * 逐条比指纹发生在 **node 侧**（tools/playtest.cjs 的 crossEngineRows：它 import 的就是这批 js/ 模块）。
   * ms 只打印不断言（机器快慢不同是事实）；**msCap 击穿必须为 0** —— 一旦 >0，ms 闸就参与了判定，
   * 同一个 seed 在快慢机器上就是两张盘，那是定价问题。
   */
  const TIERS_TEST = ['5x5', '6x6', '7x7'];
  const SEEDS_TEST = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const crossengine = async () => {
    const samples = [];
    const notProven = [];
    const noFp = [];
    const perTier = {};
    let msCapBreaches = 0;
    let nodeCapBreaches = 0;
    for (const tier of TIERS_TEST) {
      let ok = 0;
      for (const seed of SEEDS_TEST) {
        H().open(tier, seed, false);                 // restore=false：不许拿上一档的存档当续局
        await wait(0);                               // 让 repaint / persist 落地
        const st = S();
        if (!st) { notProven.push(`${tier}/${seed}: state() 为空`); continue; }
        if (st.proven !== true) notProven.push(`${tier}/${seed}: proven=${st.proven}`);
        if (!st.fingerprint) noFp.push(`${tier}/${seed}`);
        const p = st.proof || {};
        msCapBreaches += p.stoppedByMs || 0;
        nodeCapBreaches += p.stoppedByNodes || 0;
        if (st.proven === true && st.fingerprint) ok++;
        samples.push({
          tier, seed, fingerprint: st.fingerprint, clueCount: st.clueCount,
          refereeCalls: p.refereeCalls, refereeMaxMs: p.refereeMaxMs, refereeMaxNodes: p.refereeMaxNodes,
          stoppedByMs: p.stoppedByMs || 0, stoppedByNodes: p.stoppedByNodes || 0, proven: st.proven === true,
        });
      }
      perTier[tier] = `${ok}/${SEEDS_TEST.length}`;
    }
    const want = TIERS_TEST.length * SEEDS_TEST.length;
    ck(`Chrome 侧 18 张盘全部 open() 出来且有出货盘指纹（${samples.length}/${want} 有读数）`,
      samples.length === want && noFp.length === 0, `缺指纹 ${noFp.join(' ') || '0'} · 交回 ${samples.length} 组`);
    ck('18 张盘全部通过**页面自己的**验收（proven=true：裁判唯一 + BASIC 推得完 + 端点齐）',
      notProven.length === 0, notProven.join(' ') || `每档 ${Object.values(perTier).join(' ')}`);
    ck(`Chrome 侧 18 张盘的 msCap 击穿合计 = 0（实测 ${msCapBreaches}）`, msCapBreaches === 0,
      `msCap 击穿 ${msCapBreaches} 次 · nodeCap 击穿 ${nodeCapBreaches} 次（后者方向安全，允许 >0）`);
    ck('每档 6/6 出货（分布逐档打印，聚合数不许掩盖单档塌方）',
      TIERS_TEST.every((t) => perTier[t] === '6/6'), JSON.stringify(perTier));
    const msList = samples.map((s) => s.refereeMaxMs).sort((a, b) => a - b);
    return report({
      boards: samples.length, perTier,
      chromeMsCapBreaches: msCapBreaches, chromeNodeCapBreaches: nodeCapBreaches,
      // 同 boot 腿：耗时与 timeOrigin 是这台机器的读数，判定看的是上面那两个击穿计数。
      _chromeMaxMs: Number((msList[msList.length - 1] || 0).toFixed(3)),
      _chromeMedianMs: Number((msList[(msList.length - 1) >> 1] || 0).toFixed(3)),
      _timeOrigin: H().doc.timeOrigin,
      href: location.href,
      nodeWitness: 'crossEngineFingerprints', samples,
    });
  };

  // ==================================================== 场景 B · CDP 真指针把一张 5×5 走完
  /**
   * 只走真指针：页面交**坐标**，node 侧 tools/playtest.cjs 用 Input.dispatchMouseEvent 点下去
   * （不是 element.click() —— 那等于没测命中盒与事件目标）。多回合：
   *   round 0 起步读数 + 全部命中盒（点不动是谁的锅，先归因）+ 交"往给定格点面板数字"那两下
   *   round 1 认那次落子被拒（盘面零变化 + #hint 念出交互规则 + place() 直接回 why:'given-cell'），交 15 对坐标
   *   round 2 认 15 格全写完、0 冲突，交 #btn-judge 那一下
   *   round 3 认判定成立（#verdict 可见且 class ok、#status 有「完成」、state().solved === true、
   *          玩家写的那串编号逐格等于 node 侧真解）
   * 坐标每回合现量：DOM 只在换档时重建节点（js/render/board.js 的口径），量到的就是将要被点的那个。
   */
  let PTR = null;
  const cellEl = (c) => document.querySelector(`#board [data-cell="${c}"]`);
  const numEl = (v) => document.querySelector(`#palette button[data-value="${v}"]`);
  const givenCells = (E) => new Set(E.clues.map((c) => c.cell));
  const givenVals = (E) => new Set(E.clues.map((c) => c.v));
  /** node 侧真解 → 玩家该写的那串两位十六进制（给定格恒为 00，与 js/store.js 的 encodeEntries 同形状）。 */
  const wantEntries = (E) => {
    const gc = givenCells(E);
    const byCell = new Array(E.n).fill(0);
    for (let v = 1; v <= E.n; v++) if (!gc.has(E.solution[v])) byCell[E.solution[v]] = v;
    return byCell.map((v) => v.toString(16).padStart(2, '0')).join('');
  };

  const pointer = async (ctx) => {
    const round = (ctx && ctx.round) || 0;
    const E = exp();
    if (!E || !E.ok) { ck('指针腿的期望值（真解与题面）由 node 证人交回', false, w.__expectRaw); return report(); }
    if (round === 0) {
      const st = S();
      ck('指针腿起步就是证人那张盘（?tier=5x5&seed=h0 定盘）',
        !!st && st.tier === E.tier && st.seed === E.seed && st.fingerprint === E.fingerprint,
        st ? `${st.tier}/${st.seed}/${st.fingerprint} vs ${E.tier}/${E.seed}/${E.fingerprint}` : 'state() 为空');
      if (!st) return report();
      ck('起步验收通过且 #reject 收起', st.proven === true && hiddenTight('#reject'), whyNotTight('#reject'));
      ck('起步玩家一格都没写（mine=0，empty = node 侧的非给定格数）',
        st.counts.mine === 0 && st.counts.empty === E.mine,
        `mine=${st.counts.mine} empty=${st.counts.empty} want ${E.mine}`);
      eq('起步 entries 全 00', st.entries, '00'.repeat(E.n));
      // 命中盒：先证明"点得到"，再谈点不动是谁的锅
      const cellBad = [];
      for (let c = 0; c < E.n; c++) {
        const el = cellEl(c);
        if (!el) { cellBad.push(`${c}:节点不存在`); continue; }
        const p = centerOf(el);
        const hit = document.elementFromPoint(p.x, p.y);
        const back = hit && hit.closest ? hit.closest('[data-cell]') : null;
        if (!back || Number(back.dataset.cell) !== c) {
          cellBad.push(`${c}→${hit ? (hit.id || hit.className || hit.tagName) : 'null'}`);
        }
      }
      ck(`${E.n} 个格子的中心 elementFromPoint 都落回自己（命中盒到得了控件）`, cellBad.length === 0, cellBad.slice(0, 8).join(' '));
      const numBad = [];
      for (let v = 1; v <= E.n; v++) { const el = numEl(v); const bad = el ? hitSelf(el) : '节点不存在'; if (bad) numBad.push(`${v}:${bad}`); }
      ck(`${E.n} 枚面板钮的中心点都落在自己身上`, numBad.length === 0, numBad.slice(0, 8).join(' '));
      const ctlBad = [['#btn-judge', $('#btn-judge')], ['#board-wrap', $('#board-wrap')]]
        .map(([nm, el]) => hitSelf(el) ? `${nm}:${hitSelf(el)}` : '').filter(Boolean);
      ck('判定钮与盘区在 1280×1024 上点得到', ctlBad.length === 0, ctlBad.join(' '));

      PTR = {
        beforeEntries: st.entries, beforeSteps: st.steps,
        negCell: E.clues[0].cell,
        negValue: (() => { const gv = givenVals(E); for (let v = 1; v <= E.n; v++) if (!gv.has(v)) return v; return null; })(),
      };
      ck('负样本坐标量得到（给定格 + 一个玩家可写的数）',
        PTR.negCell >= 0 && PTR.negValue >= 1 && givenCells(E).has(PTR.negCell), JSON.stringify(PTR));
      return {
        pending: [centerOf(cellEl(PTR.negCell)), centerOf(numEl(PTR.negValue))],
        stage: 'negative',
      };
    }

    if (round === 1) {
      const st = S();
      // 读的是 #hint 那条**提示文本**（dom.hintLine），不是 dom.hint —— 后者在 js/main.js 的映射里是 #btn-hint 那颗按钮
      const why = text(D().hintLine);
      ck('往给定格点面板数字被拒：#hint 念出交互规则（不是静默失败）',
        why.indexOf('印着的题面') >= 0, why.slice(0, 120));
      ck('那次点击没动盘面：entries 与步数逐字未变',
        st.entries === PTR.beforeEntries && st.steps === PTR.beforeSteps,
        `entries ${st.entries.slice(0, 20)}… vs ${PTR.beforeEntries.slice(0, 20)}… · steps ${st.steps} vs ${PTR.beforeSteps}`);
      const negPrinted = E.clues.filter((c) => c.cell === PTR.negCell)[0].v;
      eq('那一格的 data-value 还是印着的数', cellEl(PTR.negCell).dataset.value, negPrinted);
      const direct = H().place(PTR.negCell, PTR.negValue);
      ck('place() 直接调用也交回 why:given-cell（交互规则的出处）',
        !!direct && direct.ok === false && direct.why === 'given-cell', JSON.stringify(direct));
      const plan = [];
      const gc = givenCells(E);
      for (let v = 1; v <= E.n; v++) {
        if (gc.has(E.solution[v])) continue;          // 印着的格不需要玩家写
        plan.push(centerOf(cellEl(E.solution[v])));
        plan.push(centerOf(numEl(v)));
      }
      ck(`写盘子的坐标配齐（${plan.length / 2} 个非给定格 × 2 下）`, plan.length === 2 * E.mine, `${plan.length} vs ${2 * E.mine}`);
      PTR.plan = plan;
      return { pending: plan, stage: 'solve' };
    }

    if (round === 2) {
      const st = S();
      ck('15 个非给定格全由真指针写完（counts.mine = node 侧的 mine）',
        st.counts.mine === E.mine && st.counts.filled === E.n && st.counts.empty === 0,
        `mine=${st.counts.mine}/${E.mine} filled=${st.counts.filled}/${E.n} empty=${st.counts.empty}`);
      ck('写满之后 0 处冲突（断边数为 0，conflictCells 空）',
        st.conflicts === 0 && st.conflictCells.length === 0, `${st.conflicts} · ${st.conflictReason} · ${JSON.stringify(st.conflictCells)}`);
      ck('盘上没有 data-conflict 的格子', document.querySelectorAll('#board [data-conflict]').length === 0,
        document.querySelectorAll('#board [data-conflict]').length);
      eq('#stat-filled 与人手读数同口径', text(D().filled).replace(/\s+/g, ' '), `已填 ${E.n}/${E.n}（印着 ${E.clueCount} · 你写 ${E.mine}）`);
      const badCenter = [];
      for (let c = 0; c < E.n; c++) {
        const el = cellEl(c);
        const want = el.dataset.value === '0' ? '' : el.dataset.value;   // js/render/board.js：空格不写字
        if (el.textContent !== want) badCenter.push(`${c}:${JSON.stringify(el.textContent)}/${want}`);
      }
      ck('每格 DOM 写的数与 data-value 一致（屏上读数不是影子）', badCenter.length === 0, badCenter.slice(0, 6).join(' '));
      return { pending: [centerOf($('#btn-judge'))], stage: 'judge' };
    }

    // round 3：判定之后的摊账
    const st = S();
    ck('点了 #btn-judge 之后 #verdict 可见（hidden=false、display 不是 none、中心点还能命中它自己）',
      D().verdict.hidden === false && shown('#verdict') && hitSelf($('#verdict')) === '',
      `${whyNotTight('#verdict')} | hitSelf=${hitSelf($('#verdict')) || 'ok'}`);
    ck('#verdict 带 ok 类且写着这条链成立',
      D().verdict.classList.contains('ok') && text(D().verdict).indexOf('王步相邻的链') > 0, text(D().verdict).slice(0, 120));
    ck('#status 里有「完成」字样', text(D().status).indexOf('完成') === 0, text(D().status));
    ck('state().solved === true 且判定原话是 ok（rules.verifyNumbering 的返回串）',
      st.solved === true && H().app.judgeOut && H().app.judgeOut.verdict === 'ok',
      `solved=${st.solved} verdict=${H().app.judgeOut && H().app.judgeOut.verdict}`);
    eq('玩家自己填出来的那串编号 = node 侧真解（逐格）', st.entries, wantEntries(E));
    const raw = JSON.parse(H().gate.saveRaw() || '{}');
    eq('存档里那串 entries 也是玩家写的（不是题面）', raw.entries, wantEntries(E));
    ck('走完这张盘用的手数 = 非给定格数（一次落子一步）', st.steps === E.mine, `${st.steps} vs ${E.mine}`);
    ck('全程没用过提示（零猜测这条腿不靠提示也不靠真值）', st.hints === 0 && st.hintStalls === 0, `${st.hints}/${st.hintStalls}`);
    const out = report({
      tier: st.tier, seed: st.seed, mine: st.counts.mine, steps: st.steps, solved: st.solved,
      clicks: 2 * E.mine + 3, fingerprint: st.fingerprint, href: location.href,
    });
    PTR = null;
    return out;
  };

  // ==================================================== 键盘通道的公共件（场景 D 与 E 共用）
  /**
   * 键 → 方向位移。与 js/main.js 的 onKey 同一套键名，但**期望值由这个模型算**，
   * 不是"跟页面上一次读数对表"：每键一个精确期望，才抓得住"同一条 keydown 绑了两处 ⇒ 一次走两格"。
   * 这个 oracle 是 js/ui/game.js 的 move()/nudge()/setEmpty() 公式的第二份拼写（闸侧独立实现）：
   * 它抓的是**接线**（双绑 / 焦点守卫 / preventDefault / 存档），抓不了**语义变更**——
   * 语义变更由 tools/rule-test.mjs 那条腿负责，别把这条腿当成语义闸。
   */
  const KEY_DRIFT = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };

  /**
   * 纯模型：从 startSel 起把 keys 挨个走一遍，交回**每键的期望**（选中格 / 选中格显示值 / 手数）。
   * 题面（given 格与 given 数）来自 node 证人的 E.clues；**E.solution 一个字节都不读**。
   * @param breakAt 阴性自证：把这一格的期望**多走一步**（真键盘不会走两步 ⇒ 该键必红）。
   */
  const kbOracle = (E, startSel, keys, breakAt) => {
    const R = E.R, C = E.C, n = E.n;
    const givenCell = new Set(E.clues.map((c) => c.cell));
    const givenVal = new Set(E.clues.map((c) => c.v));
    const val = new Array(n).fill(0);
    for (const cl of E.clues) val[cl.cell] = cl.v;         // 给定格在 cellVal 里预填（js/ui/game.js 的口径）
    let sel = startSel, steps = 0, stalled = 0;
    const per = [];
    keys.forEach((key, i) => {
      const mult = (i === breakAt && KEY_DRIFT[key]) ? 2 : 1;
      const d = KEY_DRIFT[key];
      if (d) {
        const before = sel;
        let r = Math.floor(sel / C) + d[0] * mult;
        let c = (sel % C) + d[1] * mult;
        r = Math.max(0, Math.min(R - 1, r));               // 永不出盘：钳在盘内，不环绕
        c = Math.max(0, Math.min(C - 1, c));
        sel = r * C + c;
        if (sel === before) stalled++;                     // 触边次数（模型侧证人：这条序列确实压到了边界）
      } else if (key === '=' || key === '+' || key === '-' || key === '_') {
        const delta = (key === '=' || key === '+') ? 1 : -1;
        const mult2 = (i === breakAt) ? 2 : 1;             // 阴性自证也允许打在写键上
        if (!givenCell.has(sel)) {
          const cur = val[sel];
          const from = cur || (delta > 0 ? 0 : 2);         // 空格按 + 从 1 起、按 - 从 1 起（js/ui/game.js）
          let v = from + delta * mult2;
          if (v >= 1 && v <= n) {
            while (v >= 1 && v <= n && givenVal.has(v)) v += delta;   // 印着的数不在玩家可写范围里
            if (v >= 1 && v <= n && v !== cur) {
              for (let k = 0; k < n; k++) if (val[k] === v) val[k] = 0;  // 同一个值永远只占一格
              val[sel] = v; steps++;
            }
          }
        }
      } else if (key === 'Backspace' || key === 'Delete') {
        if (!givenCell.has(sel) && val[sel]) { val[sel] = 0; steps++; }
      }
      per.push({ key, sel, val: String(val[sel]), steps });
    });
    return { per, stalled, end: sel };
  };

  /** 从 from 单调走到 to（先修行后修列，越界不存在 ⇒ 终点就是 to）。 */
  const homeKeys = (from, to, C) => {
    const out = [];
    const dr = Math.floor(to / C) - Math.floor(from / C);
    const dc = (to % C) - (from % C);
    for (let i = 0; i < Math.abs(dr); i++) out.push(dr > 0 ? 'ArrowDown' : 'ArrowUp');
    for (let i = 0; i < Math.abs(dc); i++) out.push(dc > 0 ? 'ArrowRight' : 'ArrowLeft');
    return out;
  };

  /**
   * 页内键盘**证人**：window 上的第二个 keydown 监听器，注册时机在 js/main.js 之后
   * ⇒ 同一次派发里它跑在 onKey 之后，读到的是"页面处理完之后的状态"。
   * 它不 preventDefault、不调任何 hidato.* 动词，只抄一份读数；
   * `dp`（defaultPrevented）是**这条派发被处理过**的直接证据，`tgt` 是**派发跟着焦点**的直接证据。
   */
  const KLOG = [];
  const installKeyRecorder = () => {
    if (w.__kbRecorder) return;
    w.__kbRecorder = true;
    w.addEventListener('keydown', (ev) => {
      const g = H().game;
      if (!g) return;
      const t = ev.target;
      const el = document.querySelector(`#board [data-cell="${g.sel}"]`);
      KLOG.push({
        key: ev.key,
        tgt: `${t && t.tagName ? t.tagName : '?'}#${(t && t.id) || ''}`,
        sel: g.sel,
        val: el ? el.dataset.value : '<无节点>',
        steps: Number((String(text(D().steps)).match(/\d+/) || ['<无量>'])[0]),
        dp: ev.defaultPrevented,
        scrollY: w.scrollY,
      });
    });
  };
  const takeKlog = () => KLOG.splice(0, KLOG.length);

  /** 每键一行的对账：期望来自 kbOracle（派发**之前**就算好），实测来自 KLOG。 */
  const perKeyRows = (tag, want, got) => {
    const bad = [];
    let n = 0;
    for (let i = 0; i < want.length; i++) {
      const g = got[i];
      const okShape = !!g && g.key === want[i].key && g.sel === want[i].sel &&
        g.val === want[i].val && g.steps === want[i].steps;
      n++;
      ck(`${tag}#${i} ${want[i].key} ⇒ 选中格=${want[i].sel} 显示值=${want[i].val} 手数=${want[i].steps}`,
        okShape, g ? `实测 key=${g.key} sel=${g.sel} val=${g.val} steps=${g.steps}` : '这一键页内没有读数');
      if (!okShape) bad.push(`${i}:${want[i].key}`);
    }
    ck(`${tag} 派发数与页内抄到的 keydown 数逐键相同（多一处绑定 / 少一次派发都会在这儿红）`,
      got.length === want.length, `页内 ${got.length} 条 / 派发 ${want.length} 条 · 不合 ${bad.slice(0, 6).join(' ')}`);
    return n;
  };

  // ================================================== 场景 D · 真键盘通道（键盘腿）
  /**
   * 四段，段与段之间必须换回合，因为**焦点是页外状态**（node 派发中间页面对不了焦点）：
   *   回合 0 证人（visibilityState / activeElement 显式钉在 #board）+ 算好三段的全部期望
   *   回合 1 认 A 段（15 次方向键的逐键期望轨迹）+ 认 preventDefault（scrollY 与 defaultPrevented）
   *   回合 2 焦点显式送进 #seed（INPUT）派发**同一串**方向键 ⇒ 失灵段：每键 sel 一步不许动
   *   回合 3 焦点拔回 #board，认 C 段（回巢方向键 + = + / + / ⌫ / ⌫ / - / ⌫ 的逐键格值与手数）
   * 全程不调 hidato.press() / place() / nudge() / erase() / move()：唯一写盘的通道是派发进来的键。
   */
  const KB_A = ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight',
    'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',
    'ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowDown'];
  const KB_C = ['=', '=', '+', 'Backspace', 'Backspace', '-', 'Backspace'];
  let KB = null;
  let KB_STRAY = '';                       // 钉焦点**之前** activeElement 的实测值（证人，不是标签）
  let KB_PINNED = '';                      // 钉完之后的实测值
  let KB_OBS = [];                         // A 段每次按键后实测到的选中格轨迹

  const keyboard = async (ctx) => {
    const round = (ctx && ctx.round) || 0;
    const E = exp();
    if (!E || !E.ok) { ck('键盘腿的期望（题面与几何）由 node 证人交回', false, String(w.__expectRaw).slice(0, 160)); return report(); }
    installKeyRecorder();
    const ae = () => document.activeElement || {};
    const pin = (el) => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); el.focus({ preventScroll: true }); };

    if (round === 0) {
      // 键盘腿必须**自带前置**：一个 profile 只在一个 URL 形态之内共用，形态里六条腿吃同一份
      // localStorage ⇒ pointer 那条走完的 5x5/h0 会被这儿当存档续上，"这一格是空的""手数从 0 起"
      // 全部错位（真跑一次默认清单就红 30 条）。所以先清档、再按 node 证人重出一张没被写过的盘。
      // open() 是**开局**动词不是落子动词：本腿要被测的写盘通道只有一个 —— node 派发进来的键。
      const wiped = H().gate.wipeSave();
      ck('起步先把档清掉（wipeSave 读回 null，且新 profile 之外不欠任何前提）',
        wiped === null && localStorage.getItem('hidato.save.v1') === null, String(wiped));
      H().open(E.tier, E.seed, false);
      const st = S();
      ck('键盘腿起步就是证人那张盘（?tier=&seed= 定盘，指纹逐字节 = node 侧）',
        !!st && st.tier === E.tier && st.seed === E.seed && st.fingerprint === E.fingerprint,
        st ? `${st.tier}/${st.seed}/${st.fingerprint}` : 'state() 为空');
      if (!st) return report();
      ck('起步这张盘玩家一格都没写（mine=0 / steps=0 / entries 全 00）',
        st.counts.mine === 0 && st.steps === 0 && st.entries === '00'.repeat(E.n),
        `mine=${st.counts.mine} steps=${st.steps} entries=${st.entries.slice(0, 16)}…`);
      // ① 证人先行（焦点不显式钉住 ⇒ 同一条键盘通道读数在 0/2/7 之间跳）
      // 诚实口径：这一条验的是 **playtest 自己那记可见性覆写在位**（arm() 用 defineProperty 把
      // document.hidden/visibilityState 改回来过，headless 默认报 hidden，等重绘的回合会对着一个
      // 假装在后台的 tab 超时）。它**不是**"浏览器真觉得这个 tab 可见"的证人。真到页面的证据在
      // 后面那两条硬的：逐键 ev.target 一律读到 DIV#board，且逐键选中格轨迹与题面模型逐键一致。
      ck('playtest 的可见性覆写在位（真派发到了页面由 ev.target 与逐键轨迹那两条兜）',
        document.visibilityState === 'visible', document.visibilityState);
      ck('document.readyState === "complete"（脚本还在爬的时候 window 上还没有 onKey）',
        document.readyState === 'complete', document.readyState);
      const stray = ae();
      KB_STRAY = `${stray.tagName || '?'}#${stray.id || ''}`;
      ck('钉焦点前记下现场（activeElement 是谁都被抄进 extra；不靠上一步点击的副产品）',
        !!stray.tagName, JSON.stringify(stray.tagName) + '#' + (stray.id || ''));
      pin($('#board'));
      ck('焦点被**显式**钉在 #board（DIV tabindex=0，不是 INPUT/SELECT/TEXTAREA）',
        ae().tagName === 'DIV' && ae().id === 'board', `${ae().tagName}#${ae().id}`);
      KB_PINNED = `${ae().tagName}#${ae().id}`;
      ck('#board 焦点没把页面滚走（focus 之前 scrollY 也是 0）', w.scrollY === 0, `scrollY=${w.scrollY}`);
      const se = document.scrollingElement || document.documentElement;
      ck('这一页在键盘腿的视口里**真的可滚**（scrollY===0 那条不是白断言）',
        se.scrollHeight > w.innerHeight + 1, `scrollHeight=${se.scrollHeight} innerHeight=${w.innerHeight}`);

      const start = E.clues.length ? (() => { const g = new Set(E.clues.map((c) => c.cell)); for (let c = 0; c < E.n; c++) if (!g.has(c)) return c; return 0; })() : 0;
      ck('起步选中格 = 题面里第一个非给定格（js/ui/game.js 的 firstOpen，期望由**题面**算不是抄读数）',
        st.selected === start, `实测 ${st.selected} / 期望 ${start}`);
      const selCount = document.querySelectorAll('#board [data-selected="1"]');
      ck('DOM 上恰好一格带 data-selected="1"，且就是那一格（屏上读数不是影子）',
        selCount.length === 1 && Number(selCount[0].dataset.cell) === start,
        `${selCount.length} 格 · ${Array.from(selCount).map((e) => e.dataset.cell).join(',')}`);
      // 阴性自证（SABOTAGE=1 ⇒ E.kbBreak===1）：把**第一个真的会动的方向键**的期望多走一步。
      // 挑"真的会动"的那一格，是为了不让钳位把这条负样本吞掉（触边时多走一步与少走一步同格 ⇒ 假阴性）。
      // 期望的输入：**只有题面**的冻结视图（R/C/n/clues）。真解 solution 与指纹都不在里面，
      // 所以"键盘的期望抄了答案"这件事在这条腿里是结构上不可能的，不靠 code review 保证。
      const KB_PV = Object.freeze({
        R: E.R, C: E.C, n: E.n,
        clues: Object.freeze(E.clues.map((c) => Object.freeze({ v: c.v, cell: c.cell }))),
      });
      let brk = -1;
      if (E.kbBreak === 1) {
        const probe = kbOracle(KB_PV, start, KB_A, -1);
        for (let i = 0; i < KB_A.length; i++) {
          const prevSel = i ? probe.per[i - 1].sel : start;
          if (KEY_DRIFT[KB_A[i]] && probe.per[i].sel !== prevSel) { brk = i; break; }
        }
        ck('阴性自证接线生效：期望轨迹里被故意打断的那一格找得到（找不到就是旋钮没接上）',
          brk >= 0, `brk=${brk}`);
      }
      const planA = kbOracle(KB_PV, start, KB_A, brk);
      KB = { pv: KB_PV, E, start, brk, planA, planC: null, deadSel: planA.end, keysTotal: 0, deadSteps: 0, deadTgts: [], traceA: KB_A.length + 1 };
      ck('起始格 + A 段轨迹长度 = 键数 + 1（每次按键前后都有读数）',
        KB.traceA === KB_A.length + 1, `${KB.traceA} vs ${KB_A.length + 1}`);
      ck('A 段这条序列确实压到了盘边（模型侧证人：触边 ≥ 1 次）',
        planA.stalled >= 1, `触边 ${planA.stalled} 次`);
      ck('键盘期望吃的是**只有题面**的冻结视图（solution 这个键根本不在输入里 ⇒ 结构上抄不了答案）',
        Object.isFrozen(KB_PV) && !('solution' in KB_PV) && !('fingerprint' in KB_PV) &&
        KB_PV.clues.every((c) => Object.isFrozen(c)),
        JSON.stringify(Object.keys(KB_PV)) + ' · clues 冻结 ' + KB_PV.clues.every((c) => Object.isFrozen(c)));
      takeKlog();                                        // 钉焦点不算派发：把可能的噪声清空
      return { pendingKeys: KB_A.map((key) => ({ key })), stage: 'arrows' };
    }

    if (round === 1) {
      const got = takeKlog();
      perKeyRows('键盘A方向键', KB.planA.per, got);
      KB_OBS = got.map((g) => g.sel);
      ck('A 段每一键都被页面处理过（defaultPrevented 逐键为真）',
        got.length > 0 && got.every((g) => g.dp === true), got.filter((g) => !g.dp).map((g) => g.key).join(' '));
      ck('A 段每一键派发目标都是 #board（ev.target 是 DIV ⇒ 守卫放行）',
        got.length > 0 && got.every((g) => g.tgt === 'DIV#board'), Array.from(new Set(got.map((g) => g.tgt))).join(' '));
      ck('方向键一路按下来 window.scrollY 始终是 0（preventDefault 的正面证据）',
        w.scrollY === 0 && got.every((g) => g.scrollY === 0), `末尾 ${w.scrollY} · 中途 ${got.filter((g) => g.scrollY !== 0).length} 次非 0`);
      ck('方向键不许写盘：A 段之后手数还是 0（走了 15 步也没污染存档）',
        S().steps === 0, S().steps);
      const stEnd = S();
      ck('A 段末尾选中格 = 期望轨迹的最后一步（模型与页面到这儿还逐键一致）',
        stEnd.selected === KB.planA.end, `${stEnd.selected} vs ${KB.planA.end}`);
      // ④ 负例：焦点在 INPUT 里 ⇒ 同一串键必须失灵
      pin($('#seed'));
      ck('焦点被**显式**送进 #seed（INPUT；ev.target 守卫的分支）',
        ae().tagName === 'INPUT' && ae().id === 'seed', `${ae().tagName}#${ae().id}`);
      KB.deadSel = stEnd.selected;
      KB.keysTotal = got.length;
      return { pendingKeys: KB_A.map((key) => ({ key })), stage: 'dead-input' };
    }

    if (round === 2) {
      const got = takeKlog();
      ck('失灵段派发数 = 页内抄到的 keydown 数（派发真的走焦点，不是页内自己演的）',
        got.length === KB_A.length, `页内 ${got.length} / 派发 ${KB_A.length}`);
      let dead = 0;
      for (let i = 0; i < KB_A.length; i++) {
        const g = got[i];
        ck(`失灵段#${i} ${KB_A[i]} ⇒ 选中格一步没动（仍在 ${KB.deadSel}）且 target=INPUT#seed`,
          !!g && g.sel === KB.deadSel && g.tgt === 'INPUT#seed',
          g ? `实测 sel=${g.sel} target=${g.tgt}` : '页内没有这条读数');
        if (g && g.sel === KB.deadSel && g.tgt === 'INPUT#seed') dead++;
      }
      ck('失灵段每一键都没被 preventDefault（守卫 return 在 preventDefault 之前 ⇒ 浏览器留着默认行为）',
        got.length > 0 && got.every((g) => g.dp === false), got.filter((g) => g.dp).map((g) => g.key).join(' '));
      ck(`失灵段确认过的步数 = ${KB_A.length}（负例自己也要交条数，不许只用一个布尔盖）`,
        dead === KB_A.length, `${dead} / ${KB_A.length}`);
      KB.deadSteps = dead;
      KB.deadTgts = Array.from(new Set(got.map((g) => g.tgt)));
      pin($('#board'));
      ck('焦点从 INPUT 里拔回 #board（别污染后面的断言）',
        ae().tagName === 'DIV' && ae().id === 'board', `${ae().tagName}#${ae().id}`);
      const keysC = homeKeys(KB.deadSel, KB.start, E.C).concat(KB_C);
      KB.planC = kbOracle(KB.pv, KB.deadSel, keysC, -1);   // 阴性自证只打 A 段那一条轨迹
      return { pendingKeys: keysC.map((key) => ({ key })), stage: 'write' };
    }

    // 回合 3：C 段逐键对账 + 摊账
    const got = takeKlog();
    perKeyRows('键盘C写键', KB.planC.per, got);
    ck('C 段派发目标一律是 #board（回巢方向键与写键同一焦点）',
      got.length > 0 && got.every((g) => g.tgt === 'DIV#board'), Array.from(new Set(got.map((g) => g.tgt))).join(' '));
    const st = S();
    ck('C 段末尾回到 firstOpen 那一格（期望由题面算，不是抄页面读数）',
      st.selected === KB.start, `${st.selected} vs ${KB.start}`);
    const last = KB.planC.per[KB.planC.per.length - 1];
    ck('C 段最后一次的格值与手数等于模型值（DOM/模型/state 三方在此合流）',
      Number(cellEl(KB.start).dataset.value) === Number(last.val) && st.steps === last.steps,
      `DOM ${cellEl(KB.start).dataset.value} / 模型 ${last.val} · state.steps ${st.steps} / 模型 ${last.steps}`);
    ck('末尾 #stat-filled 与人手读数同口径（DOM 层的独立证人）',
      text(D().filled).replace(/\s+/g, ' ') === `已填 ${E.clueCount}/${E.n}（印着 ${E.clueCount} · 你写 0）`,
      text(D().filled));
    ck('全程 window.scrollY 仍是 0（三段按下来一次也没滚页）', w.scrollY === 0, `scrollY=${w.scrollY}`);
    ck('三段派发数各自交回得清：A 段 15、失灵段 15、C 段等于 C 段期望轨迹长度',
      KB.keysTotal === KB_A.length && KB.deadSteps === KB_A.length && got.length === KB.planC.per.length,
      `A ${KB.keysTotal} · B ${KB.deadSteps} · C ${got.length}`);
    ck('C 段的期望也吃同一张**只有题面**的冻结视图（回巢步数 = 行列差的绝对值和）',
      !('solution' in KB.pv) && homeKeys(KB.deadSel, KB.start, KB.pv.C).length ===
      Math.abs(Math.floor(KB.start / KB.pv.C) - Math.floor(KB.deadSel / KB.pv.C)) + Math.abs((KB.start % KB.pv.C) - (KB.deadSel % KB.pv.C)),
      `回巢 ${homeKeys(KB.deadSel, KB.start, KB.pv.C).length} 步 · 行差 ${Math.abs(Math.floor(KB.start / KB.pv.C) - Math.floor(KB.deadSel / KB.pv.C))} 列差 ${Math.abs((KB.start % KB.pv.C) - (KB.deadSel % KB.pv.C))}`);
    const raw = JSON.parse(H().gate.saveRaw() || '{}');
    ck('键盘写出来的手确实落了盘（存档 entries 与 state() 逐字相同）',
      raw.entries === st.entries, `${String(raw.entries).slice(0, 12)}… vs ${st.entries.slice(0, 12)}…`);
    const out = report({
      tier: E.tier, seed: E.seed,
      keysTotal: KB.keysTotal + got.length + KB_A.length,
      traceLen: KB.traceA,
      deadSegmentConfirmed: KB.deadSteps,
      arrowsDispatched: KB_A.length, writeDispatched: got.length,
      selStart: KB.start, selEndA: KB.planA.end, selFinal: st.selected,
      selTraceExpected: KB.planA.per.map((p) => p.sel),
      selTraceObserved: KB_OBS,
      stalledInModel: KB.planA.stalled,
      boundaryProbeValue: last.val, stepsFinal: st.steps,
      scrollY: w.scrollY,
      focusBeforePin: KB_STRAY, focusPinned: KB_PINNED,
      deadSegmentTargets: KB.deadTgts,
      sabotageBreakAt: KB.brk, fingerprint: st.fingerprint,
    });
    KB = null;
    return out;
  };

  // ============================================= 场景 E · 跨**真刷新**续玩（resume 腿）
  /**
   * 为什么这条腿必须走 Page.reload 而不是同文档片段导航：
   * 同文档只换 `#hash` 时 window.hidato 还活着、store.load() 一次都没跑，
   * "恢复了"其实是"什么都没丢"——那是续局闸最经典的假绿。
   * 铁证三条，全在回合 2 里：① node 派发刷新**之前**在页外取的 timeOrigin/href/state 与刷新后不同/对得上；
   * ② node 设在 window 上的哨兵串在刷新后读不到了（JS 上下文真的没了）；
   * ③ 新文档的 boot.requested 落在存档那一档上，而存档的档位**故意不等于默认档位**
   *   （默认是 TIERS[0]=5x5/h0，这一腿写的是 6x6/m1 ⇒ 续出来的盘不可能是"默认值恰好一样"）。
   */
  let RS = null;
  const resume = async (ctx) => {
    const round = (ctx && ctx.round) || 0;
    const E = exp();
    if (!E || !E.ok) { ck('续局腿的期望（题面与几何）由 node 证人交回', false, String(w.__expectRaw).slice(0, 160)); return report(); }
    installKeyRecorder();
    const store = await mod('./js/store.js');

    if (round === 0) {
      const st0 = S();
      ck('续局腿起步无 URL 查询串（盘只能来自默认或存档）', location.search === '', `search=${location.search}`);
      const wiped = H().gate.wipeSave();
      ck('本腿先把存档清干净（腿内自带前置，不吃上一条腿写的档），wipeSave 读回 null',
        wiped === null && localStorage.getItem(store.SAVE_KEY) === null, String(wiped));
      const opened = H().open(E.tier, E.seed, false);
      const st = S();
      ck('hidato.open() 交回 summary（它**没有 ok 字段**：成败读 state()，别把成功读成失败）',
        !!opened && opened.tier === E.tier && !('ok' in opened), JSON.stringify(opened).slice(0, 120));
      ck('换到的那一档**不等于默认档**（续局读数才有出处）',
        E.tier !== H().tiers[0].key && E.seed !== 'h0', `${E.tier}/${E.seed} vs 默认 ${H().tiers[0].key}/h0`);
      ck('换档后 state() 就是证人那张盘（指纹逐字节 = node 侧 witness）',
        !!st && st.fingerprint === E.fingerprint && st.tier === E.tier && st.seed === E.seed,
        st ? `${st.tier}/${st.seed}/${st.fingerprint} vs ${E.fingerprint}` : 'state() 为空');
      if (!st) return report();
      ck('起步玩家一格都没写（entries 全 00）', st.entries === '00'.repeat(E.n), st.entries.slice(0, 24));
      RS = { E, start: st.selected, keys: ['=', '=', 'ArrowRight', 'ArrowDown'], plan: null };
      RS.plan = kbOracle(Object.freeze({ R: E.R, C: E.C, n: E.n, clues: E.clues }), RS.start, RS.keys, -1);
      takeKlog();
      return { pendingKeys: RS.keys.map((key) => ({ key })), stage: 'play' };
    }

    if (round === 1) {
      const got = takeKlog();
      perKeyRows('续局真键盘', RS.plan.per, got);
      const st = S();
      ck('真键盘打了几步之后玩家确实有手（两笔都写在同一个选中格上 ⇒ mine=1、手数=2）',
        st.counts.mine === 1 && st.steps === RS.plan.per[RS.plan.per.length - 1].steps && st.steps === 2,
        `mine=${st.counts.mine} steps=${st.steps} 期望 steps=${RS.plan.per[RS.plan.per.length - 1].steps}`);
      const raw = localStorage.getItem(store.SAVE_KEY);
      ck(`${store.SAVE_KEY} 被写了（刷新前证人之一）`, typeof raw === 'string' && raw.length > 0, String(raw).slice(0, 80));
      let obj = null;
      try { obj = JSON.parse(raw || 'null'); } catch { obj = null; }
      ck('存档里的 entries/steps/hints 与 state() 逐字相同（档是活的，不是上一次的历史）',
        !!obj && obj.entries === st.entries && obj.steps === st.steps && obj.hints === st.hints,
        JSON.stringify(obj).slice(0, 200));
      ck('#save-note 念出的正是这一档（键名在句首，用户 Ctrl-F 也命中）',
        text(D().saveNote).indexOf(store.SAVE_KEY) === 0 &&
        text(D().saveNote).indexOf(`盘号 ${st.seed} · ${st.steps} 手 · ${st.hints} 次提示`) > 0,
        text(D().saveNote).slice(0, 160));
      // 阴性自证（PLANT_TRUTH=1）：把 node 侧真值**当场写进 localStorage**，让刷新后那两条扫描必须抓到。
      if (E.plant === 1) {
        const plantedKey = 'hidato.plantprobe';
        localStorage.setItem(plantedKey, E.solution.slice(1).join(','));
        ck('阴性自证：真值被当场写进 localStorage（写了才算，写不进就是旋钮没接上）',
          localStorage.getItem(plantedKey) === E.solution.slice(1).join(','), String(plantedKey));
      }
      // 把刷新前的读数交给 node（node 自己还会另取一份 timeOrigin/href/state 作独立证人）。
      RS.pre = {
        tier: st.tier, seed: st.seed, entries: st.entries, steps: st.steps, hints: st.hints,
        selected: st.selected, fingerprint: st.fingerprint, mine: st.counts.mine,
      };
      return Object.assign({
        reload: E.fakeReload === 1 ? `fragment:${location.href}#resume-probe` : 1,
        stage: 'reload', pre: RS.pre, carry: { keysDone: RS.keys.length, start: RS.start },
      }, drain());
    }

    // 回合 2：刷新之后。ctx.carry.pre = **node 自己在派发刷新之前用 Runtime.evaluate 取的**刷新前证人；
    // ctx.carry.pageReported = 上一回合页面交回的那份（两份必须逐字相同 ⇒ 页面没在对自己演戏）。
    const carry = (ctx && ctx.carry) || {};
    const pre = carry.pre || null;
    ck('刷新前证人由 node 带回来了（不是页面在同一个上下文里自己跟自己对表）', !!pre && typeof pre.entries === 'string', JSON.stringify(carry).slice(0, 200));
    if (!pre) return report();
    ck('node 那份证人里带着它在旧上下文里设的哨兵串（派发前它确实跑进了那个文档）',
      typeof pre.sentinel === 'string' && pre.sentinel.length > 0, String(pre.sentinel));
    ck('node 取的刷新前读数与页面自己交回的读数逐字相同（两条通道在刷新前就合流）',
      !!carry.pageReported && carry.pageReported.entries === pre.entries &&
      carry.pageReported.steps === pre.steps && carry.pageReported.seed === pre.seed &&
      carry.pageReported.tier === pre.tier && carry.pageReported.fingerprint === pre.fingerprint,
      JSON.stringify(carry.pageReported).slice(0, 200));
    const st = S();
    ck('新文档里 window.hidato 又起来了（state() 有读数）', !!st, 'null');
    if (!st) return report({ href: location.href });
    // ① node 设在旧上下文里的哨兵：同文档跳转它一定还在
    ck('node 在刷新前设的 window 哨兵在新文档里读不到了（**新 JS 上下文**的铁证；片段跳转它还在 ⇒ 这条红）',
      w.__hidatoPreReloadSentinel === undefined, String(w.__hidatoPreReloadSentinel));
    const nowOrigin = String(performance.timeOrigin);
    const nowHref = location.href;
    ck('performance.timeOrigin 与 node 带回来的旧值**不同**（新文档的第二条铁证）',
      nowOrigin !== pre.timeOrigin, `刷新前 ${pre.timeOrigin} / 刷新后 ${nowOrigin}`);
    ck('hidato.doc.timeOrigin 报的就是当前文档那个（模块是重新求值的，不是抄的旧值）',
      H().doc.timeOrigin === nowOrigin, `${H().doc.timeOrigin} vs ${nowOrigin}`);
    ck('旧文档里 node 读到的 hidato.doc.timeOrigin 就等于旧文档的 performance.timeOrigin（页面那栏没撒谎）',
      pre.docTimeOrigin === pre.timeOrigin, `${pre.docTimeOrigin} vs ${pre.timeOrigin}`);
    ck('location.href 与刷新前逐字相同且 hash 为空（片段导航偷改 href ⇒ 这条红）',
      nowHref === pre.href && location.hash === '', `刷新前 ${pre.href} / 刷新后 ${nowHref} hash=${location.hash}`);
    ck('hidato.doc.href 与 location.href 一致', H().doc.href === nowHref, H().doc.href);
    // ② 续的是档，不是默认值
    const b = H().boot || {};
    ck('boot.hasSaveAtBoot === true（文档加载时确实读到了档）', b.hasSaveAtBoot === true, JSON.stringify(b));
    ck('boot.resumed === true（openBoard 真的 decode 了存档；同文档跳转它不会翻）',
      b.resumed === true, JSON.stringify(b));
    ck('boot.requested 落在**存档那一档**上，且它不等于默认档（URL 没带查询串 ⇒ 出处只有存档）',
      b.requested && b.requested.tier === pre.tier && b.requested.seed === pre.seed &&
      b.requested.tier !== H().tiers[0].key, JSON.stringify(b.requested));
    // ③ 逐格对账
    eq('档位与刷新前一致', st.tier, pre.tier);
    eq('盘号原样续上（不是日期算的）', st.seed, pre.seed);
    eq('手数量与刷新前一致', st.steps, pre.steps);
    eq('提示数与刷新前一致', st.hints, pre.hints);
    eq('重生成的出货盘指纹 = node 侧 witness（逐字节）', st.fingerprint, E.fingerprint);
    eq('题面条数 = node 侧', st.clueCount, E.clueCount);
    ck('这一盘仍通过页面自己的验收（proven=true）', st.proven === true, JSON.stringify(st.proof).slice(0, 240));
    // 逐格对账。注意两个口径别混：存档 entries 里**印着的格恒为 00**（题面不落盘，见 js/store.js），
    // 而 DOM 的 data-value 上印着的格带着题面那个数 ⇒ 给定格的 DOM 证人要对的是题面，不是 entries。
    const printedVal = {};
    for (const cl of E.clues) printedVal[cl.cell] = cl.v;
    let cellBad = 0, restored = 0, givenSeen = 0;
    for (let c = 0; c < E.n; c++) {
      const was = parseInt(pre.entries.substr(c * 2, 2), 16);
      const now = parseInt(st.entries.substr(c * 2, 2), 16);
      const el = document.querySelector(`#board [data-cell="${c}"]`);
      const domVal = el ? Number(el.dataset.value) : -1;
      const printed = printedVal[c] !== undefined;
      const domOk = printed ? (domVal === printedVal[c] && el.dataset.given === '1') : domVal === now;
      if (printed) givenSeen++;
      if (was !== now || !domOk) cellBad++;
      if (was > 0) restored++;
      if (was > 0 || c < 3) ck(`第 ${c} 格恢复值逐个相同（${printed ? '印着的格按题面口径对' : '玩家格 DOM 显示同一个数'}）`,
        was === now && domOk, `刷新前 ${was} / 刷新后 ${now} / DOM ${domVal}${printed ? ` / 题面 ${printedVal[c]}` : ''}`);
    }
    ck(`${E.n} 格 entries 逐格对完：不合 0 格（其中题面 ${givenSeen} 格）`, cellBad === 0, `不合 ${cellBad} 格`);
    ck('刷新前玩家写过的格确实一格不丢（非空计数相同）', restored === st.counts.mine && restored === pre.mine, `${restored} vs ${st.counts.mine}`);
    ck('存档解回来的那几手是真键盘写的那几手（entries 与 node 带回来的串逐字相同）',
      st.entries === pre.entries, `${st.entries.slice(0, 16)}… vs ${pre.entries.slice(0, 16)}…`);
    ck('续玩之后选中格回落到 firstOpen（decode 的口径，不是刷新前那个光标位）',
      st.selected === (() => { const g = new Set(E.clues.map((c2) => c2.cell)); for (let c = 0; c < E.n; c++) if (!g.has(c)) return c; return 0; })(),
      `${st.selected}`);
    // ④ 给定格仍只读
    const gc = E.clues[0].cell;
    const gv = E.clues[0].v;
    const gv2 = (() => { const s = new Set(E.clues.map((c) => c.v)); for (let v = 1; v <= E.n; v++) if (!s.has(v)) return v; return null; })();
    const blocked = H().place(gc, gv2);
    ck('刷新后给定格仍然只读：place() 交回 why:given-cell',
      !!blocked && blocked.ok === false && blocked.why === 'given-cell', JSON.stringify(blocked));
    const gEl = document.querySelector(`#board [data-cell="${gc}"]`);
    ck('那一格 DOM 上还带着 data-given="1" 且显示印着的数（刷新没把题面洗成玩家的手）',
      gEl && gEl.dataset.given === '1' && Number(gEl.dataset.value) === gv && gEl.textContent === String(gv),
      gEl ? `${gEl.dataset.given}/${gEl.dataset.value}/${gEl.textContent}` : '节点不存在');
    const givenErase = H().game.select(gc) && H().erase();
    ck('给定格连 ⌫ 那条动词也清不掉（why:given-cell；题面在新文档里仍然是题面）',
      !!givenErase && givenErase.ok === false && givenErase.why === 'given-cell', JSON.stringify(givenErase));
    H().game.select(pre.selected >= 0 ? pre.selected : 0);
    // ⑤ 落盘卫生
    const lsKeys = Object.keys(localStorage);
    ck(`localStorage 除 ${store.SAVE_KEY} 以外没有别的键（真值不落盘这条在**新文档**里重认一遍）`,
      lsKeys.length === 1 && lsKeys[0] === store.SAVE_KEY, JSON.stringify(lsKeys));
    const rawStr = localStorage.getItem(store.SAVE_KEY) || '';
    let obj = null;
    try { obj = JSON.parse(rawStr); } catch { obj = null; }
    ck('存档字段名 ⊂ 白名单（多一个键就红）',
      !!obj && Object.keys(obj).every((f) => store.SAVE_FIELDS.indexOf(f) >= 0),
      `在档 ${obj ? JSON.stringify(Object.keys(obj)) : '读不开'} / 白名单 ${JSON.stringify(store.SAVE_FIELDS)}`);
    ck('存档里没有答案味的字段名（js/store.js 的 ANSWERISH 当场用它自己扫自己）',
      !store.ANSWERISH.test(rawStr) && lsKeys.every((k) => !store.ANSWERISH.test(k)), rawStr.slice(0, 120));
    const forms = [E.solution.join(','), E.solution.slice(1).join(','), (() => {
      const byCell = new Array(E.n).fill(-1);
      for (let v = 1; v <= E.n; v++) byCell[E.solution[v]] = v;
      return byCell.join(',');
    })()];
    ck('localStorage 全键全值里扫不到 node 侧真值的任何一种拼法',
      lsKeys.every((k) => forms.every((f) => (localStorage.getItem(k) || '').indexOf(f) < 0)),
      `扫了 ${lsKeys.length} 个键 · 形态 ${forms.length} 种`);
    ck('#save-note 在新文档里念的是续上的那一档',
      text(D().saveNote).indexOf(store.SAVE_KEY) === 0 && text(D().saveNote).indexOf(`盘号 ${pre.seed} · ${pre.steps} 手`) > 0,
      text(D().saveNote).slice(0, 160));
    const out = report({
      tier: st.tier, seed: st.seed, entriesCells: E.n, restoredCells: restored,
      steps: st.steps, hints: st.hints, mine: st.counts.mine,
      timeOriginChanged: nowOrigin !== pre.timeOrigin,
      hrefUnchanged: nowHref === pre.href, sentinelCleared: w.__hidatoPreReloadSentinel === undefined,
      reloadMode: carry.reloadMode || 'none（node 没派发刷新）',
      keysDispatchedBeforeReload: carry.keysDone,
      _timeOriginBefore: pre.timeOrigin, _timeOriginAfter: nowOrigin,
      fingerprint: st.fingerprint, href: nowHref,
    });
    RS = null;
    return out;
  };

  // ==================================================== 场景 F · 真窄屏 / 移动端（窄屏腿）
  /**
   * 这一腿存在的理由是这个家族踩过的那颗假绿：兄弟仓的"移动腿"**先起一个进程设
   * Emulation.setDeviceMetricsOverride 就退出**，再另起进程跑场景 ⇒ 跑断言的那个进程从没被覆写，
   * 在 vw 1280 / narrow=false 下把桌面那套断言又跑一遍，报出与桌面腿相同的条数。
   * 所以这里三条缺一不可：
   *   ① 覆写发生在**这条腿自己那一次 playtest 调用**里（attach 之后、首次导航之前，同一个 session）；
   *   ② 腿内把 vw/dpr/clientWidth 读回来**当成断言**（不是装饰）：读数和请求的尺寸不符 ⇒ 腿红；
   *   ③ 断言本身是窄屏形状（横向溢出 / 命中盒 / 重排证人 / 44px 指尖目标），条数与桌面腿不可能相同。
   * 期望的 (W, H, D, mobile) 由 verify.sh 写进 node 证人的 JSON 里带进来：页内读不到 env，
   * 而"请求了什么"必须与"量到了什么"逐条对上，否则覆写有没有生效没人知道。
   */
  const NARROW_TIERS = ['5x5', '6x6', '7x7'];
  const rectOverlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 ? w : 0) * (h > 0 ? h : 0);
  };

  const narrow = async () => {
    const E = exp();
    ck('窄屏腿的期望（出货盘 + 请求的视口三元组）由 node 侧带进来（缺了就必须红）',
      !!E && E.ok === true && Number.isInteger(E.vwWant) && Number.isInteger(E.dprWant),
      String(w.__expectRaw).slice(0, 160));
    if (!E || !E.ok) return report({ href: location.href });
    const W = E.vwWant, Hh = E.vhWant, Dp = E.dprWant;
    const vw = w.innerWidth, vh = w.innerHeight, dpr = w.devicePixelRatio;
    const cw = document.documentElement.clientWidth;

    // ① 覆写证人：这四对读数就是"覆写在这条腿自己的调用里生效"的证人。
    eq('覆写证人 1/5 innerWidth = 请求的窄屏宽度（桌面腿读到的是 Chrome 窗口宽 1280）', vw, W);
    eq('覆写证人 2/5 devicePixelRatio = 请求的 dpr（现成 VIEWPORT=WxH 写死 1，这一条要求它带得出 D）', dpr, Dp);
    eq('覆写证人 3/5 documentElement.clientWidth = 请求的宽度', cw, W);
    eq('覆写证人 4/5 innerHeight = 请求的高度', vh, Hh);
    ck('覆写证人 5/5 请求的不是桌面那一对（W≠1280 或 D≠1）——否则这条腿就是在重跑桌面断言',
      W !== 1280 || Dp !== 1, `请求 ${W}×${Hh}×${Dp}`);

    // ② CSS 侧的证人：窄屏那条 media query（max-width:520px）命中，桌面那条（min-width:901px）不命中。
    //    这两条在 1280×1024 的桌面配置上是**反的**，所以它们不是白断言（本仓 css/game.css 末尾那个 @media）。
    const mq = (q) => w.matchMedia(q).matches;
    eq('窄屏 media query (max-width:520px) 命中（样式真的按窄屏那套在算，不是只换了个窗口）', mq('(max-width: 520px)'), 'true');
    eq('桌面 query (min-width:901px) 不命中（同一句话在桌面配置上必红）', mq('(min-width: 901px)'), 'false');

    // ③ 起步：这一腿开的是**最宽的一档**（溢出风险最大），且必须是 node 证人那张盘。
    const st0 = S();
    ck('窄屏腿起步就是证人那张盘（state() 有读数）', !!st0, 'null');
    if (!st0) return report({ href: location.href });
    eq('起步档位 = 窄屏腿指定的那一档（最宽 = 溢出风险最大）', `${st0.tier}/${st0.seed}`, `${E.tier}/${E.seed}`);
    eq('起步出货盘指纹 = node 侧 witness（窄屏腿跑的是真货盘，不是空页面）', st0.fingerprint, E.fingerprint);

    // ④ 逐档量：横向不溢出 + 格数对得上 + 页面自己的验收仍通过。
    const perTier = {};
    for (const tk of NARROW_TIERS) {
      H().open(tk, E.seed, false);
      await wait(0);
      const st = S();
      const tier = H().tiers.find((t) => t.key === tk);
      const cells = document.querySelectorAll('#board [data-cell]');
      const de = document.documentElement;
      ck(`${tk} 在窄屏上仍通过页面自己的验收（proven=true）`, !!st && st.proven === true, st ? `proven=${st.proven}` : 'state() 为空');
      eq(`${tk} 的格子节点数 = 档位表里的 n（盘画全了才谈得上溢出）`, cells.length, tier.n);
      ck(`${tk} 盘不横向溢出：documentElement.scrollWidth <= clientWidth + 1`,
        de.scrollWidth <= de.clientWidth + 1, `scrollWidth=${de.scrollWidth} clientWidth=${de.clientWidth}`);
      ck(`${tk} body 也不横向溢出（scrollWidth <= 请求宽度 + 1）`,
        document.body.scrollWidth <= W + 1, `body.scrollWidth=${document.body.scrollWidth} 请求宽度=${W}`);
      perTier[tk] = `${cells.length} 格 · dsw ${de.scrollWidth}/${de.clientWidth} · 格宽 ${
        (cells[0] ? cells[0].getBoundingClientRect().width.toFixed(2) : '—')}px`;
    }
    // 逐档量完之后**再开一次最宽那一档**：view.build 每次换档都重建节点，
    // 后面的逐格命中/几何必须对着一张刚建好、且确定是这一档的盘量。
    H().open(E.tier, E.seed, false);
    await wait(0);
    const tierW = H().tiers.find((t) => t.key === E.tier);
    const g = { tk: E.tier, tier: tierW, cells: Array.from(document.querySelectorAll('#board [data-cell]')) };
    ck(`换回最宽那一档（${E.tier}）之后格子节点数 = 档位表的 n`, g.cells.length === tierW.n, `${g.cells.length} vs ${tierW.n}`);
    const board = $('#board');
    // 命中盒要先滚得到才谈得上点得动（窄屏第一屏放不下整张盘，这本身就是窄屏的形状）。
    board.scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(0);
    const se = document.scrollingElement || document.documentElement;
    ck('窄屏页面**纵向可滚**（scrollHeight > innerHeight ⇒ 下面的命中不是白断言）',
      se.scrollHeight > w.innerHeight + 1, `scrollHeight=${se.scrollHeight} innerHeight=${w.innerHeight}`);
    const inView = g.cells.filter((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return !(x >= 0 && y >= 0 && x <= vw + 0.5 && y <= vh + 0.5);
    });
    ck(`把盘滚进视野之后 ${g.tier.n} 格的中心全部落在窄屏视口内（先证明到得了）`, inView.length === 0,
      `${inView.length} 格在外面 · 视口 ${vw}×${vh}`);
    // 逐格：中心点 elementFromPoint 落回**自己那格**（复用 hitSelf，逐格交条数）。
    let cellBad = 0;
    for (let c = 0; c < g.tier.n; c++) {
      const el = document.querySelector(`#board [data-cell="${c}"]`);
      const why = el ? hitSelf(el) : '节点不存在';
      if (why) cellBad++;
      ck(`窄屏第 ${c} 格的可点命中盒落在自己那格里（${why || '中心点命中自己'}）`, why === '', why);
    }
    ck(`${g.tier.n} 格逐格命中盒对完：不合 0 格（窄屏下没被遮挡、也没掉出视口）`, cellBad === 0, `${cellBad} 格不合`);
    const cellRects = Array.from(g.cells).map((el) => el.getBoundingClientRect());
    const minCell = Math.min.apply(null, cellRects.map((r) => Math.min(r.width, r.height)));
    ck(`${g.tier.n} 格的边长都不低于 CSS clamp 的下限 34px（纸笔可读性）`, minCell >= 34, `最小边长 ${minCell.toFixed(2)}px`);

    // 面板：先量几何（不需要在屏上），再把面板滚进视野逐枚命中。
    const nums = document.querySelectorAll('#palette button[data-value]');
    const numBad = Array.from(nums).filter((el) => {
      const r = el.getBoundingClientRect();
      return !(r.width >= 43.5 && r.height >= 44);
    });
    ck(`${nums.length} 枚面板钮的矩形都不小于 44px 指尖底线（CSS .num 的 min-height:44px）`,
      numBad.length === 0, `${numBad.length} 枚偏小 · 首枚 ${nums.length ? nums[0].getBoundingClientRect().width.toFixed(2) : '—'}px`);
    $('.palette-wrap').scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(0);
    const pickIdx = [0, Math.floor(nums.length / 3), Math.floor(nums.length / 2), Math.floor(2 * nums.length / 3), nums.length - 1];
    for (const i of pickIdx) {
      const el = nums[i];
      const why = el ? hitSelf(el) : '节点不存在';
      ck(`面板抽样第 ${i} 枚（值 ${el ? el.dataset.value : '?'}）中心点命中自己`, why === '', why);
    }

    // 控件仍可点（判定/提示/换一局/档位/盘号 + 撤销/清空）：逐个交条数。
    // 窄屏第一屏放不下"盘 + 面板 + 控件条"，所以命中前先把**这一个**控件滚进视野：
    // 这一腿要证的不是"它一屏内可见"，而是"用户滚得到它、滚到之后中心点命中它自己、且它没横向跑出屏宽"。
    const ctls = [['#btn-judge', $('#btn-judge')], ['#btn-hint', $('#btn-hint')], ['#btn-next', $('#btn-next')],
      ['#btn-undo', $('#btn-undo')], ['#btn-clear', $('#btn-clear')], ['#tier', $('#tier')], ['#seed', $('#seed')]];
    let ctlScrolled = 0;
    let ctlBad = 0;
    const ctlOutside = [];
    for (const [nm, el] of ctls) {
      if (!el) { ck(`窄屏下控件 ${nm} 仍点得到（中心点命中自己）`, false, '节点不存在'); continue; }
      const r0 = el.getBoundingClientRect();
      const cy = r0.top + r0.height / 2;
      const needed = cy < 0 || cy > vh;
      if (needed) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); await wait(0); ctlScrolled++; }
      const r1 = el.getBoundingClientRect();
      if (r1.left < -0.5 || r1.right > cw + 0.5) ctlOutside.push(`${nm} ${r1.left.toFixed(1)}..${r1.right.toFixed(1)}`);
      const why = hitSelf(el);
      if (why) ctlBad++;
      ck(`窄屏下控件 ${nm} 仍点得到（需要时先滚进视野 ⇒ 中心点命中自己）`, why === '', `${why || '命中'}${needed ? ' · 需滚动' : ' · 第一屏内'}`);
    }
    ck('每个控件滚进视野后都还在窄屏宽度之内（左右边不出 0..clientWidth ⇒ 没有横向逃出去的那一个）',
      ctlOutside.length === 0, `${ctlOutside.length} 个越界 · ${ctlOutside.slice(0, 3).join(' ')}`);
    const ctlSmall = ctls.slice(0, 5).filter(([, el]) => el.getBoundingClientRect().height < 44);
    ck('窄屏下动作键（判定/提示/换一局/撤销/清空）高度不低于 44px（@media 里那条 min-height:44px）',
      ctlSmall.length === 0, ctlSmall.map(([nm]) => nm).join(' '));

    // 盘与面板不互相遮挡 + 重排证人（这一条在桌面配置上是**反的**：桌面是并排，窄屏必须换行）。
    const boardWrap = $('#board-wrap');
    const palWrap = $('.palette-wrap');
    board.scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(0);
    const bRect = board.getBoundingClientRect(), pRect = palWrap.getBoundingClientRect();
    eq('盘与面板的矩形相交面积 = 0（窄屏下两者不叠在一起）', rectOverlap(bRect, pRect).toFixed(2), '0.00');
    ck('窄屏确实**重排**了：面板的顶边在盘的底边之下（flex-wrap 换行；桌面 1280 上两者并排 ⇒ 这条必红）',
      pRect.top >= bRect.bottom - 0.5, `面板 top=${pRect.top.toFixed(2)} / 盘 bottom=${bRect.bottom.toFixed(2)}`);
    eq('盘与控件条不相交（#board-wrap 与 #controls 的矩形相交 = 0）',
      rectOverlap(bRect, $('#controls').getBoundingClientRect()).toFixed(2), '0.00');
    ck('盘的宽度不超过可用宽度（格数 × 格宽塞得下这一档）',
      bRect.width <= cw - 14, `盘宽 ${bRect.width.toFixed(2)} / clientWidth ${cw}`);

    // 收起态仍是**真**隐藏（[hidden] 被自带 display:grid 盖过那一族 bug 在窄屏同样要断）。
    H().open(E.tier, E.seed, false);
    await wait(0);
    ck('换回证人那张盘之后 #reject 是**真**隐藏（display:none 且 0 个 rect）', hiddenTight('#reject'), whyNotTight('#reject'));
    ck('#verdict 是**真**隐藏', hiddenTight('#verdict'), whyNotTight('#verdict'));
    ck('藏起来的 #reject / #verdict 在窄屏上也点不到',
      [$('#reject'), $('#verdict')].every((el) => unhittable(el) === ''),
      [$('#reject'), $('#verdict')].map((el) => unhittable(el)).filter(Boolean).join(' · '));
    ck('#board-wrap 在窄屏上是展开的（有 rect 且 display 不是 none）',
      shown('#board-wrap') && boardWrap.getClientRects().length > 0, whyNotTight('#board-wrap'));

    // 读数条不溢出容器（字号没缩 ⇒ 文本必须自己换行或被容器接住）。
    const readouts = [D().filled, D().steps, D().conflict, D().status, D().hintLine, D().saveNote];
    for (const el of readouts) {
      ck(`读数条 #${el.id} 不溢出自己那行（scrollWidth <= clientWidth + 1）`,
        el.scrollWidth <= el.clientWidth + 1, `scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth} 文本「${text(el).slice(0, 28)}」`);
    }
    const readoutsFit = readouts.every((el) => el.scrollWidth <= el.clientWidth + 1);
    const receiptFits = D().receipt.scrollWidth <= D().receipt.clientWidth + 1;
    ck('#receipt 那块没有横向溢出（pre 自带 overflow-x:auto + white-space:pre-wrap ⇒ 它自己啃得下）',
      receiptFits, `${D().receipt.scrollWidth}/${D().receipt.clientWidth}`);

    // 收尾：窄屏腿也开过盘（persist 会写档），谁写的档谁收尾。
    const wiped = H().gate.wipeSave();
    ck('窄屏腿收尾把档清掉（三条 open 都写过档 ⇒ 不留给下一条腿）', wiped === null, String(wiped));

    const cellW = cellRects.length ? cellRects[0].width : 0;
    return report({
      vw, vh, dpr, clientWidth: cw, scrollWidth: document.documentElement.scrollWidth,
      wantViewport: `${W}x${Hh}x${Dp}`, mobileEmulation: E.mobileWant === true,
      breakpointHit: mq('(max-width: 520px)'), desktopQueryHit: mq('(min-width: 901px)'),
      tiers: NARROW_TIERS, perTier, cellsHit: `${g.tier.n - cellBad}/${g.tier.n}`,
      grid: `${g.tier.n} 格 × ${cellW.toFixed(2)}px`, boardW: Number(bRect.width.toFixed(2)),
      paletteBelowBoard: pRect.top >= bRect.bottom - 0.5,
      overlapArea: Number(rectOverlap(bRect, pRect).toFixed(2)),
      minCellPx: Number(minCell.toFixed(2)), numButtons: nums.length,
      controlsHittable: `${ctls.length - ctlBad}/${ctls.length}`,
      readouts: readouts.length, fingerprint: st0.fingerprint, href: location.href,
      // 判定用的**布尔量**留在 stdout（scrollsVertically / controlsFitWidth），原始时钟/几何读数走 `_`：
      // 这样"没有任何被判定的东西藏在 _ 键里"与"两次连跑逐字节相同"两条同时成立。
      scrollsVertically: se.scrollHeight > w.innerHeight + 1,
      controlsFitWidth: ctlOutside.length === 0, readoutsFit, receiptFitsWidth: receiptFits,
      _scrollHeight: se.scrollHeight, _receiptScrollWidth: D().receipt.scrollWidth,
      _controlsNeededScroll: ctlScrolled,
    });
  };

  // ==================================================== 场景 G · 拒盘 canary（拒绝分支的浏览器可达性）
  /**
   * 这一腿不验"页面能出货"，验的是**页面的拒绝分支在浏览器里真到得了**：
   * 只跑出货盘的闸永远说不出 stopped / count!==1 / given-adjacency / 端点齐不齐 这几条是不是死代码。
   * 通道就是页面已经开好的 `gate.loadBoard(tierKey, clues, budget)` 与 `gate.assess(...)`
   * （第三个参数只给闸用，生产 shipped 路径永远不传 ⇒ 用它把裁判掐停是合法注入，不是改产品）。
   * 两张通道分工：
   *   · assess 只现算验收**不换盘** ⇒ 归因对照（同一张题面在生产预算下是绿的，掐停就红 = 预算的锅）；
   *   · loadBoard 真的换盘 ⇒ 拒绝分支在 DOM 上开火（#reject 展开、#board-wrap 真收起）。
   * 负样本的题面与期望读数全部由 **node 侧证人**（`node tools/playtest.cjs canary <tier> <seed>`）算，
   * 页内不现生成一张盘。掐停只用 nodeCap（且 < 256 ⇒ counter.js 里每 256 个节点才查一次的 ms 闸
   * 结构上到不了）；**绝不用 msCap 造负样本** —— ms 掐停会让盘形跟着机器速度变，那是本组织的红线。
   */
  const canary = async () => {
    const E = exp();
    ck('canary 腿的五张负样本由 node 侧证人算好交回（页内不现生成盘子）',
      !!E && E.ok === true && Array.isArray(E.samples) && E.samples.length === 5,
      String(w.__expectRaw).slice(0, 200));
    if (!E || !E.ok) return report({ href: location.href });
    const uniqLine = () => {
      const t = text(D().receipt);
      const m = /唯一性\s+(\S+)（count=(-?\d+) · stopped=(true|false) · (\d+) 节点 \/ [\d.]+ ms）/.exec(t);
      return m ? { outcome: m[1], count: Number(m[2]), stopped: m[3] === 'true', nodes: Number(m[4]) } : null;
    };
    const breachLine = () => {
      const m = /预算击穿\s+nodes (\d+) 次 · ms (\d+) 次/.exec(text(D().receipt));
      return m ? { nodes: Number(m[1]), ms: Number(m[2]) } : null;
    };
    const wiped0 = H().gate.wipeSave();
    ck('起步先把档清掉（canary 不污染存档：注入前后各 wipe 一次）',
      wiped0 === null && localStorage.getItem('hidato.save.v1') === null, String(wiped0));

    const reached = {};
    const reasons = {};
    const attribution = {};
    const msSeen = {};
    let rejectedOpen = 0, boardHiddenTight = 0, provenMatch = 0;

    for (const smp of E.samples) {
      const tag = `负样本 ${smp.name}`;
      if (E.canaryDrop === smp.name) {
        // 阴性自证：这一张**不注入** ⇒ 它的"分支可达"必须红（这一腿最值钱的就是让人看见拒绝分支没被走到）。
        ck(`${tag}：本轮故意**没注入**这一张（SABOTAGE）⇒ 它那条"拒绝分支在浏览器里可达"必须红`, false,
          `E.canaryDrop=${E.canaryDrop}：跳过 assess/loadBoard ⇒ ${smp.branch} 这一段在浏览器里没有任何可达性证据`);
        continue;
      }
      const budget = smp.budget || undefined;
      const exp1 = smp.expect;

      // ── 通道 A：gate.assess（现算验收，不换盘）：页内读数必须逐条等于 node 证人
      const a = H().gate.assess(smp.tier, smp.clues, budget);
      msSeen[smp.name] = Number((a.ms || 0).toFixed(3));
      eq(`${tag} assess：outcome 逐字 = node 侧`, a.outcome, exp1.outcome);
      eq(`${tag} assess：count = node 侧（多解/掐停那两条读的是这一个数）`, a.count, exp1.count);
      eq(`${tag} assess：stopped = node 侧`, a.stopped, exp1.stopped);
      eq(`${tag} assess：stoppedBy 归因 = node 侧`, a.stoppedBy, exp1.stoppedBy);
      eq(`${tag} assess：nodes = node 侧（节点数是纯函数，node 与浏览器同读数）`, a.nodes, exp1.nodes);
      eq(`${tag} assess：pencilSolved = node 侧`, a.pencilSolved, exp1.pencilSolved);
      eq(`${tag} assess：pencilUndecided = node 侧`, a.pencilUndecided, exp1.pencilUndecided);
      eq(`${tag} assess：endpoints（missingEndpoints）= node 侧`, a.endpoints, exp1.endpoints);
      eq(`${tag} assess：conflict（givenConflict 原样串）= node 侧`, a.conflict, exp1.conflict);
      ck(`${tag} assess 的返回里没有 solutions 数组（真值不因注入而进页面）`,
        !('solutions' in a) && !('solution' in a), JSON.stringify(Object.keys(a)).slice(0, 220));

      // ── 通道 B：gate.loadBoard（真的换盘）⇒ 拒绝分支在 DOM 上开火
      const out = H().gate.loadBoard(smp.tier, smp.clues, budget);
      eq(`${tag} loadBoard：页面判定的 proven 与 node 侧同一条谓词（两份拼写在此合流）`, out.proven, exp1.proven);
      provenMatch++;
      ck(`${tag} 这一张被页面拒了（proven=false）`, out.proven === false, JSON.stringify(out).slice(0, 200));
      ck(`${tag} #reject 展开（hidden=false、display 不是 none、有 rect）`,
        out.rejectedShown === true && D().reject.hidden === false && shown('#reject'), whyNotTight('#reject'));
      ck(`${tag} #board-wrap **真**收起（hiddenTight：display:none 且 0 个 rect，不是只靠 opacity）`,
        out.boardHidden === true && hiddenTight('#board-wrap'), whyNotTight('#board-wrap'));
      ck(`${tag} 面板跟着收起（loadBoard 交回 paletteHidden=true 且 offsetParent 为空）`,
        out.paletteHidden === true && D().palette.offsetParent === null, `paletteHidden=${out.paletteHidden}`);
      rejectedOpen++; boardHiddenTight++;
      const why = text(D().rejectDetail);
      reasons[smp.name] = why;
      const detail = `${tag} #reject-detail 念出的 reason 串逐字含 ${exp1.outcome}/${exp1.count}/${exp1.stopped}`;
      ck(detail, why.indexOf(`outcome=${exp1.outcome} count=${exp1.count} stopped=${exp1.stopped}`) >= 0, why.slice(0, 200));
      reached[smp.name] = true;

      // ── 每张自己的那一支（具体 reason 串，不许只断"被拒了"）
      if (smp.name === 'pencil') {
        ck(`${tag}（BASIC 推不完）：裁判仍证成唯一 —— outcome=unique 且 count=1 且 stopped=false`,
          exp1.outcome === 'unique' && exp1.count === 1 && exp1.stopped === false,
          `实测 ${a.outcome}/${a.count}/${a.stopped}`);
        ck(`${tag} 的红的只有铅笔这一支：reject 里写着「剩 ${exp1.pencilUndecided} 格未定」且端点/题面冲突都是 null`,
          why.indexOf(`剩 ${exp1.pencilUndecided} 格未定`) >= 0 && why.indexOf('missingEndpoints=null') >= 0 &&
          why.indexOf('题面冲突=null') >= 0, why.slice(0, 240));
        // 「能开局」与「能出货」是两个分支：loadBoard 已经把 Game 建起来了（app.game 非空 ⇒
        // 盘可玩），只是 boardIsProven 不认它（不可出货）。这里当场证一遍两条都到得了。
        const gm = H().game;
        ck(`${tag}「能开局」：页面确实把这张盘建出来了（Game 在场、${gm ? gm.n : 0} 个格子节点在 DOM 里）`,
          !!gm && document.querySelectorAll('#board [data-cell]').length === gm.n,
          gm ? `n=${gm.n} 节点 ${document.querySelectorAll('#board [data-cell]').length}` : 'app.game 为空');
        const openCell = (() => {
          if (!gm) return -1;
          for (let c = 0; c < gm.n; c++) {
            const el = document.querySelector(`#board [data-cell="${c}"]`);
            if (el && el.dataset.given !== '1') return c;
          }
          return -1;
        })();
        const openVal = (() => {
          if (!gm) return -1;
          const gv = new Set();
          for (const el of document.querySelectorAll('#board [data-given="1"]')) gv.add(Number(el.dataset.value));
          for (let v = 1; v <= gm.n; v++) if (!gv.has(v)) return v;
          return -1;
        })();
        const placed = H().place(openCell, openVal);
        ck(`${tag}「能开局」：落子通道可用 —— place(非给定格 ${openCell}, 未印的数 ${openVal}) 交回 ok=true（可玩 ≠ 可出货）`,
          !!placed && placed.ok === true, `place(${openCell},${openVal}) → ${JSON.stringify(placed)}`);
        ck(`${tag}「不能出货」的读数落在"需要猜"那一侧：Game 自己的铅笔 solved=false 且 undecided>0（页面现算，不是 node 给的）`,
          !!gm && gm.pencil.solved === false && gm.pencil.undecided > 0,
          gm ? `solved=${gm.pencil.solved} undecided=${gm.pencil.undecided}` : '无 Game');
        attribution[smp.name] = 'pencilSolved=false（裁判 count=1）';
      }
      if (smp.name === 'stopped') {
        ck(`${tag} 归因是 nodes 不是 ms：stoppedBy='nodes' 且注入的预算里根本没有 msCap（红线：绝不用 msCap 造负样本）`,
          a.stoppedBy === 'nodes' && !!budget && budget.nodeCap > 0 && budget.msCap === undefined,
          `stoppedBy=${a.stoppedBy} budget=${JSON.stringify(budget)}`);
        ck(`${tag} nodeCap < 256 ⇒ counter.js 里每 256 个节点才查一次的 ms 闸在这张负样本上结构上到不了`,
          budget.nodeCap < 256, `nodeCap=${budget.nodeCap}`);
        eq(`${tag} msCap 用的就是生产档位值（闸没为了让它停而把 ms 调小）`, out.budget.msCap, E.budgetMs);
        eq(`${tag} nodeCap 用的就是注入的那一个`, out.budget.nodeCap, budget.nodeCap);
        ck(`${tag} 掐停时 count 不是"唯一"的读数：count=${a.count} 且页面不许把它当货`, a.count !== 1 || a.stopped === true,
          `count=${a.count} stopped=${a.stopped}`);
        const u = uniqLine();
        ck(`${tag} 收据「唯一性」那一行在，且写的就是 stopped=true / ${a.nodes} 节点（预算击穿的现场读数）`,
          !!u && u.outcome === 'stopped' && u.stopped === true && u.nodes === a.nodes, JSON.stringify(u));
        const br = breachLine();
        ck(`${tag} 收据上「预算击穿 nodes a 次 · ms b 次」那一行也在（注入盘走 assessBoard ⇒ 两个生成侧计数器恒 0；` +
          '这一条断的是"这行字在且解析得开"，本次掐停的归因在上一条 stoppedBy=nodes）',
          !!br && br.nodes === 0 && br.ms === 0, JSON.stringify(br));
        // 归因对照：同一张题面、生产预算 ⇒ 页面/ node 都认它是货。红的只有"预算"这一个自变量。
        const ctrl = smp.fullBudgetControl;
        const ca = H().gate.assess(smp.tier, smp.clues);
        ck(`${tag} 对照：同一张题面在**生产预算**下是绿的（node 侧 unique/count=1/pencilSolved/端点齐/无冲突）`,
          ctrl.outcome === 'unique' && ctrl.count === 1 && ctrl.pencilSolved === true &&
          ctrl.endpoints === null && ctrl.conflict === null && ctrl.proven === true, JSON.stringify(ctrl).slice(0, 200));
        ck(`${tag} 对照：页内现算的那一遍与 node 侧逐条相同（掐停是预算的锅，不是两张盘）`,
          ca.outcome === ctrl.outcome && ca.count === ctrl.count && ca.nodes === ctrl.nodes &&
          ca.pencilSolved === ctrl.pencilSolved && ca.stopped === false,
          `页面 ${ca.outcome}/${ca.count}/${ca.nodes}/${ca.pencilSolved}/${ca.stopped} vs node ${ctrl.outcome}/${ctrl.count}/${ctrl.nodes}/${ctrl.pencilSolved}/false`);
        attribution[smp.name] = `stopped=true/stoppedBy=nodes（nodeCap ${budget.nodeCap} ⇒ nodes ${a.nodes}）`;
      }
      if (smp.name === 'multiple') {
        ck(`${tag} 不唯一这一支：outcome=multiple 且 count=${a.count}≠1（数到第二个就收工）`,
          a.outcome === 'multiple' && a.count === 2 && a.count !== 1, `实测 ${a.outcome}/${a.count}`);
        ck(`${tag} reject 里写着「outcome=multiple count=2」`,
          why.indexOf('outcome=multiple count=2') >= 0, why.slice(0, 200));
        // 诚实口径：这一张的铅笔那一支**也**是红的（删掉那条线索之后 BASIC 也推不完），
        // 所以这里断的是"count!==1 这一支确实被走到并写进了 reason 串"，不断"只有它红"。
        // "只有某一支红"的形状由 endpoints 那一张（其余四条全绿）与 pencil 那一张负责。
        ck(`${tag} 诚实口径：这一张不是"只红一条"（pencilSolved=${a.pencilSolved}），断言只钉 count!==1 与 reason 串`,
          a.count !== 1 && exp1.conflict === null && a.stopped === false, `count=${a.count} stopped=${a.stopped}`);
        attribution[smp.name] = `count=${a.count}!==1（outcome=multiple）`;
      }
      if (smp.name === 'adjacency') {
        eq(`${tag} reason 逐字 = given-adjacency（rules.givenConflict 的原样串）`, a.conflict, 'given-adjacency');
        ck(`${tag} 题面不成立就不该进搜索：count=0 且 nodes=0`, a.count === 0 && a.nodes === 0,
          `count=${a.count} nodes=${a.nodes}`);
        ck(`${tag} reject 里写着「题面冲突=given-adjacency」`, why.indexOf('题面冲突=given-adjacency') >= 0, why.slice(0, 200));
        // 独立见证 B 的那一条分支：本仓**从来没有在浏览器里证明过它可达**（counter.js 走的是
        // rules.givenConflict，witness.js 是自己另写的一份判据）。这里当场 import 同一批 js/ 模块跑它。
        const gen = await mod('./js/engine/generate.js');
        const rules = await mod('./js/engine/rules.js');
        const wit = await mod('./js/engine/witness.js');
        const Gg = gen.gridFor(gen.tierOf(smp.tier));
        const wb = wit.countWitnessB(Gg, rules.toGivenCell(Gg, smp.clues));
        const want = smp.witnessB;
        eq(`${tag} witness.js 的 countWitnessB 在浏览器里也走到 given-adjacency 这一支（reason 逐字）`, wb.reason, want.reason);
        eq(`${tag} countWitnessB 的 outcome = node 侧`, wb.outcome, want.outcome);
        eq(`${tag} countWitnessB 交回 count=0（不进搜索）`, wb.count, want.count);
        eq(`${tag} countWitnessB 交回 nodes=0（不进搜索）`, wb.nodes, want.nodes);
        ck(`${tag} 两条通道（裁判 + 见证 B）对同一张非法题面同读数、且都没进搜索`,
          wb.reason === a.conflict && wb.count === a.count && wb.nodes === a.nodes,
          `witnessB ${wb.reason}/${wb.count}/${wb.nodes} vs referee ${a.conflict}/${a.count}/${a.nodes}`);
        attribution[smp.name] = 'given-adjacency（count=0/nodes=0，两条通道同读数）';
      }
      if (smp.name === 'endpoints') {
        ck(`${tag} 其余四条在这一张上**全是绿的**（归因干净：红的只有端点这一条）`,
          a.stopped === false && a.outcome === 'unique' && a.count === 1 && a.pencilSolved === true && a.conflict === null,
          `stopped=${a.stopped} outcome=${a.outcome} count=${a.count} pencilSolved=${a.pencilSolved} conflict=${a.conflict}`);
        eq(`${tag} 唯一红的那条：missingEndpoints = node 侧的那一个`, a.endpoints, exp1.endpoints);
        ck(`${tag} reject 里写着「端点：missingEndpoints=${exp1.endpoints}」`,
          why.indexOf(`端点：missingEndpoints=${exp1.endpoints}`) >= 0, why.slice(0, 200));
        ck(`${tag} boardIsProven 的 endpoints 分支在浏览器里被走过（proven=false 且 #reject 展开）`,
          out.proven === false && shown('#reject'), `proven=${out.proven}`);
        attribution[smp.name] = `endpoints=${a.endpoints}（其余四条绿）`;
      }
    }

    // 可达性总账：清单要几张、就收到几张"分支被走到过"的证人。
    for (const smp of E.samples) {
      ck(`负样本 ${smp.name} 的拒绝分支在本页被走到过（reached 证人记了一笔）`,
        reached[smp.name] === true, `canaryDrop=${E.canaryDrop || 'none'}：这一张没进注入序列 ⇒ 分支可达性没有证据`);
    }
    ck(`五张负样本全部注入过并拒了（reached 5/5 · #reject 展开 ${(E.samples.length - (E.canaryDrop ? 1 : 0))} 次）`,
      Object.keys(reached).length === E.samples.length - (E.canaryDrop ? 1 : 0) && rejectedOpen === Object.keys(reached).length,
      `reached ${JSON.stringify(Object.keys(reached))} · reject ${rejectedOpen}`);
    ck(`每一次拒收都把 #board-wrap 收成**真**隐藏（hiddenTight 计数与注入数相同）`,
      boardHiddenTight === Object.keys(reached).length, `${boardHiddenTight} vs ${Object.keys(reached).length}`);
    ck('node 侧谓词与页面 boardIsProven 逐张对账（两份拼写一张不落）',
      provenMatch === Object.keys(reached).length, `${provenMatch} vs ${Object.keys(reached).length}`);

    // 恢复：注入盘不许留在页面上，也不许留在档里。
    const back = H().open(E.tier, E.seed, false);
    await wait(0);
    const st = S();
    ck('收尾把证人那张正常盘开回来（open 交回 summary 且 state() 有读数）',
      !!back && !!st && back.tier === E.tier, JSON.stringify(back).slice(0, 140));
    eq('恢复后的出货盘指纹 = node 侧 witness（页面上不再挂着注入盘）', st.fingerprint, E.fingerprint);
    ck('恢复后的盘通过页面自己的验收（proven=true）且 #reject 收起、#board-wrap 展开',
      st.proven === true && hiddenTight('#reject') && shown('#board-wrap'), whyNotTight('#reject'));
    const wiped1 = H().gate.wipeSave();
    const lsKeys = Object.keys(localStorage);
    ck('收尾再 wipe 一次：canary 不污染存档（wipeSave 读回 null 且 localStorage 一个键都不剩）',
      wiped1 === null && lsKeys.length === 0, `wipeSave=${wiped1} keys=${JSON.stringify(lsKeys)}`);

    return report({
      samples: E.samples.length, reachedNames: Object.keys(reached),
      reasons: Object.keys(reasons).map((k) => `${k}→${(reasons[k].split('\n')[0] || '').slice(0, 58)}`),
      attribution, stopNodeCap: E.stopNodeCap, msCapNeverUsed: true,
      rejectRows: rejectedOpen, boardHiddenRows: boardHiddenTight, provenMatches: provenMatch,
      baseTier: E.tier, baseSeed: E.seed, restoredFingerprint: st ? st.fingerprint : null,
      sabotageDrop: E.canaryDrop || null, href: location.href,
      _assessMsBySample: msSeen, _baseAssessMs: Number((E.baseAssess && E.baseAssess.ms || 0).toFixed(3)),
    });
  };

  w.__scn = { boot, crossengine, pointer, keyboard, resume, narrow, canary };
})(window);
