// 浏览器闸跑在页面里的场景：注入后由 tools/playtest.cjs 的 `scenario|interact <名>` 调 window.__scn.<名>()。
//
// 本回合三条腿（简报的验收合同）：
//   · boot        场景 A · 启动与"页面里没有答案"（含 URL 定盘、msCap=0 证人、真值扫描）
//   · crossengine 场景 C · 18 张出货盘的**跨引擎指纹对账**（页侧收集，node 侧逐条比）
//   · pointer     场景 B · CDP 真指针把一张 5×5 走完（多回合：页面交坐标，node 去点）
// 键盘腿 / 续局腿 / canary 腿 / 移动端腿归下一条回合（2d），这里**没有半成品**。
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
      timeOrigin: H().doc.timeOrigin, bfsNodes: scan.nodes, domNodes: scan.domNodes,
      domHandleWhitelist: scan.allowed, chromeRefereeMaxMs: st.proof ? Number(st.proof.refereeMaxMs.toFixed(3)) : null,
      nodeRefereeMaxMs: Number(E.maxMs.toFixed(3)), budgetMs: E.budgetMs, msCapBreaches: rw.breachMs,
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
      chromeMaxMs: Number((msList[msList.length - 1] || 0).toFixed(3)),
      chromeMedianMs: Number((msList[(msList.length - 1) >> 1] || 0).toFixed(3)),
      href: location.href, timeOrigin: H().doc.timeOrigin,
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

  w.__scn = { boot, crossengine, pointer };
})(window);
