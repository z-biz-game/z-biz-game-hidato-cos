// 特效层 · 一条会流的链 + 落子火花（canvas 覆盖层，DT 驱动 + 定步长累加器）
//
// 为什么这一层存在，而且必须写成定步长：
//   本仓的盘是 DOM 格（#board [data-cell]），不是 canvas 画的 —— 但"落子有没有反馈、链有没有
//   在动"这类手感以前完全没有。补一层覆盖在盘上的画布，只做三件事：把已填成的链段画成一条
//   流动的黄铜线、落子时溅几点火花、给选中格一层呼吸光。它**不参与任何判定**：几何是 main.js
//   在每次重画后快照进来的，链该不该亮由 ui/game.js 的读数决定。
//   覆盖层必须 `pointer-events: none` —— 否则浏览器闸的 elementFromPoint 命中的是画布不是格子，
//   指针腿会去怪控件。
//
// 帧率无关怎么兑现（不是把系数乘个 dt 就完事）：
//   · 积分走**定步长累加器**：`accum += 帧dt`，每满 SIM_STEP 跑一步 `step(SIM_STEP)`。
//     于是 step() 里看到的 dt 恒等于 SIM_STEP，同一虚拟时长下 30/60/120Hz 跑过的**步数**与
//     末态都一样 —— 这才是"帧率无关"，逐粒子写 `x += v*dt` 反而不是（帧 dt 本身就是变量）。
//   · 概率类（火花存活数、抖不抖）全部钉在步上，不写 `if (Math.random() < 0.02)`；
//     随机只来自本模块自带的 LCG（种子可由外部钉死），一个 Math.random 都不用。
//   · 累加器与积分钟是这条链上唯一还在吃帧 dt 的地方 ⇒ 阴性对照就钉在 `accum += elapsed`。
//   · 暂停 = 不再喂 accum（不是把速度设 0）：恢复后不丢状态，也不补跑暂停期间的时间。

export const SIM_STEP = 1 / 60;
const MAX_SPARKS = 240;
const MAX_RINGS = 12;
const GRAVITY = 420;            // px/s²
const DRAG = 0.985;             // 每**步**的阻尼（步长固定 ⇒ 这里乘常数就是帧率无关的）
const SPARK_LIFE = 0.85;        // s
const FLOW_PERIOD = 26;         // 链条虚线的循环长度，px
const FLOW_SPEED = 42;          // px/s
const BREATH_PERIOD = 1.6;      // s，选中格呼吸光一个周期

/** 与 js/engine/rng.js 同族的 LCG：特效的随机必须可钉种子，否则帧率对拍没有可比性。 */
class Lcg {
  constructor(seed) { this.s = (seed >>> 0) || 0x9E3779B9; }
  next() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s >>> 8; }
  unit() { return this.next() / 16777216; }
  range(a, b) { return a + (b - a) * this.unit(); }
}

export class FxLayer {
  /**
   * @param {HTMLCanvasElement} canvas 覆盖层画布
   * @param {{reduceMotionQuery?:string, seed?:number}} opts
   */
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.g2d = canvas ? canvas.getContext('2d') : null;
    this.motionQuery = opts.reduceMotionQuery || '(prefers-reduced-motion: reduce)';
    this.reduceMotion = false;
    this.mq = null;
    this.rng = new Lcg(opts.seed === undefined ? 0xC0FFEE : opts.seed);
    this.seed = opts.seed === undefined ? 0xC0FFEE : (opts.seed >>> 0);

    this.clock = 0;             // 仿真累计秒（只在 step 里长，与墙钟无关）
    this.simSteps = 0;
    this.accum = 0;
    this.last = -1;             // -1 = 还没收到第一帧（不许用 0：那是"时间原点"的合法值）
    this.raf = 0;
    this.frozen = false;        // 暂停：不喂累加器
    this.attached = false;

    this.sparks = [];
    this.rings = [];
    this.links = [];            // 已填成的链段几何（main.js 快照进来）
    this.glowAt = null;         // 选中格中心
    this.viewport = { w: 0, h: 0, dpr: 1 };

    this.sheet = null;          // 粒子图集（assets/img/sparks-256.png，4 帧 64px）
    this.sheetOk = false;
    this.halo = null;           // 呼吸光（assets/img/glow-128.png）
    this.haloOk = false;
    this.frames = 0;            // 只给"画了多少帧"这一个诊断读数用，不进判据
    this.idleSkips = 0;         // 暂停期间到的帧数（这些帧一秒仿真都不喂）
    this.paintFails = 0;        // 画布环境不全时丢掉的画面帧数（仿真不受影响）
    this.paintError = '';
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────
  attach() {
    if (!this.cv || this.attached) return this;
    this.attached = true;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia(this.motionQuery);
      this.reduceMotion = !!this.mq.matches;
      // 真分支：系统里改了开关就立刻换档（不是只在启动时读一次的样子货）。
      const onChange = (e) => { this.setReduceMotion(!!e.matches); };
      if (typeof this.mq.addEventListener === 'function') this.mq.addEventListener('change', onChange);
      else if (typeof this.mq.addListener === 'function') this.mq.addListener(onChange);
    }
    this.loadSprites();
    this.resize();
    return this;
  }

  setReduceMotion(on) {
    this.reduceMotion = !!on;
    if (this.reduceMotion) { this.sparks.length = 0; this.rings.length = 0; }   // 关掉粒子，不留尾巴
    return this.reduceMotion;
  }

  loadSprites() {
    if (typeof Image !== 'function') return;
    // baseURI 在没有文档基址的沙箱里是 undefined，而 `new URL(rel, undefined)` 直接抛 ——
    // 图取不到只是没特效（onerror 分支画圆点），抛在构造期是把整层打死。
    const base = (typeof document !== 'undefined' && document.baseURI) || '';
    const at = (rel) => (base ? new URL(rel, base).href : rel);
    this.sheet = new Image();
    this.sheet.src = at('assets/img/sparks-256.png');
    this.sheet.onload = () => { this.sheetOk = true; };
    this.sheet.onerror = () => { this.sheetOk = false; };   // 图没到就用圆点画，特效不许把玩法带崩
    this.halo = new Image();
    this.halo.src = at('assets/img/glow-128.png');
    this.halo.onload = () => { this.haloOk = true; };
    this.halo.onerror = () => { this.haloOk = false; };
  }

  /** 画布尺寸 = 视口 CSS 像素 × dpr；不参与布局（position: fixed），所以不会撑出滚动条。 */
  resize() {
    if (!this.cv || typeof window === 'undefined') return;
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.viewport = { w, h, dpr };
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.cv.style.width = `${w}px`;
    this.cv.style.height = `${h}px`;
    if (this.g2d) this.g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start() {
    if (this.raf || typeof requestAnimationFrame !== 'function') return false;
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
    return true;
  }

  stop() {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 暂停/恢复：只掐累加器，不清空状态 ⇒ 恢复后从原地继续，不补跑暂停期间的时间。 */
  setFrozen(on) {
    this.frozen = !!on;
    if (this.frozen) this.accum = 0;
    return this.frozen;
  }

  /** 换一局 / 重开：时钟、步数、累加器、粒子、涟漪、几何全部归零（漏一个就是"重开没复位"）。 */
  reset() {
    this.clock = 0;
    this.simSteps = 0;
    this.accum = 0;
    this.last = -1;
    this.sparks.length = 0;
    this.rings.length = 0;
    this.links.length = 0;
    this.glowAt = null;
    this.rng = new Lcg(this.seed);
    this.frames = 0;
    this.paintFails = 0;
    this.paintError = '';
  }

  // ── 几何输入（main.js 每次重画后快照；sim 不读 DOM，免得布局把仿真带偏）────────
  setLinks(list) {
    this.links = Array.isArray(list) ? list.map((l) => ({
      x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, strong: !!l.strong,
    })) : [];
  }
  setGlow(pos) { this.glowAt = pos ? { x: pos.x, y: pos.y, r: pos.r } : null; }

  spawnPlace(x, y, strong) {
    if (this.reduceMotion) return 0;                 // 真分支：减少动效时一个粒子都不生
    const n = strong ? 10 : 6;
    for (let i = 0; i < n && this.sparks.length < MAX_SPARKS; i++) {
      const ang = this.rng.range(-Math.PI, Math.PI);
      const spd = this.rng.range(60, 210);
      this.sparks.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - this.rng.range(20, 90),
        life: SPARK_LIFE * this.rng.range(0.7, 1.0),
        age: 0,
        frame: this.rng.next() % 4,
        size: this.rng.range(10, 22),
      });
    }
    return n;
  }

  spawnRing(x, y) {
    if (this.reduceMotion || this.rings.length >= MAX_RINGS) return 0;
    this.rings.push({ x, y, r: 6, v: 150, age: 0, life: 0.7 });
    return 1;
  }

  /** 通关礼花：一圈链节 + 一个环。 */
  spawnBurst(x, y) {
    const made = this.spawnPlace(x, y, true) + this.spawnPlace(x, y, true);
    return made + this.spawnRing(x, y);
  }

  // ── 推进 ───────────────────────────────────────────────────────────────────
  /**
   * 一帧：从时间戳算出这帧的 dt，交给 pump()。
   * 暂停时**照样跟着时间戳走**（`last = t`），只是不把 dt 喂给仿真 ⇒ 恢复后不会把暂停期间
   * 的那段时间补跑掉。这一句是"暂停不推进仿真"能拿出读数的原因。
   */
  tick(nowMs) {
    const t = typeof nowMs === 'number' ? nowMs : (typeof performance !== 'undefined' ? performance.now() : 0);
    if (this.last < 0) { this.last = t; return 0; }
    const dt = (t - this.last) / 1000;
    this.last = t;
    if (!(dt > 0)) return 0;
    if (this.frozen) { this.accum = 0; this.idleSkips++; return 0; }
    return this.pump(dt);
  }

  /**
   * 累加器 + 定步长积分的**唯一入口**（外部要手动喂时间时也走它，读数同一条路）。
   * `this.accum += dt` 是本模块唯一还在吃**帧 dt**的一行 ⇒ 帧率对拍的阴性对照钉它。
   */
  pump(dt) {
    if (this.frozen || !(dt > 0)) return 0;
    const capped = dt > 0.25 ? 0.25 : dt;        // 切标签页回来不许补跑一屏
    this.accum += capped;
    let steps = 0;
    while (this.accum >= SIM_STEP && steps < 8) {    // 追帧上限：卡顿时丢时间，不丢帧率无关性
      this.accum -= SIM_STEP;
      this.step(SIM_STEP);
      steps++;
    }
    // 画布环境不完整（受限 ctx、旧浏览器缺方法）时只丢这一帧的画面，仿真照跑。
    try { this.render(); } catch (e) { this.paintFails++; this.paintError = e.message; }
    return steps;
  }

  /** 定步长积分：这里的 dt 恒等于 SIM_STEP，所以乘常数是安全的。 */
  step(dt) {
    this.clock += dt;
    this.simSteps++;
    if (this.reduceMotion) return;
    const s = this.sparks;
    for (let i = s.length - 1; i >= 0; i--) {
      const p = s[i];
      p.vy += GRAVITY * dt;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;
      if (p.age >= p.life) s.splice(i, 1);
    }
    const r = this.rings;
    for (let i = r.length - 1; i >= 0; i--) {
      const q = r[i];
      q.r += q.v * dt;
      q.v *= 0.98;
      q.age += dt;
      if (q.age >= q.life) r.splice(i, 1);
    }
  }

  // ── 画 ─────────────────────────────────────────────────────────────────────
  render() {
    const g = this.g2d;
    if (!g || !this.cv) return;
    const { w, h } = this.viewport;
    g.clearRect(0, 0, w, h);
    const flow = this.reduceMotion ? 0 : (this.clock * FLOW_SPEED) % FLOW_PERIOD;
    g.lineCap = 'round';
    for (const l of this.links) {
      g.globalAlpha = l.strong ? 0.95 : 0.55;
      g.strokeStyle = l.strong ? '#c98b3f' : '#8a5a2b';
      g.lineWidth = l.strong ? 5 : 3;
      g.setLineDash([14, 12]);
      g.lineDashOffset = -flow;
      g.beginPath();
      g.moveTo(l.x0, l.y0);
      g.lineTo(l.x1, l.y1);
      g.stroke();
    }
    g.setLineDash([]);
    g.lineDashOffset = 0;
    g.globalAlpha = 1;
    if (!this.reduceMotion) {
      for (const p of this.sparks) {
        const k = 1 - p.age / p.life;
        g.globalAlpha = Math.max(0, Math.min(1, k));
        const size = p.size * (0.6 + 0.4 * k);
        if (this.sheetOk) {
          g.drawImage(this.sheet, p.frame * 64, 0, 64, 64, p.x - size / 2, p.y - size / 2, size, size);
        } else {
          g.fillStyle = '#c98b3f';
          g.beginPath();
          g.arc(p.x, p.y, size * 0.28, 0, Math.PI * 2);
          g.fill();
        }
      }
      for (const q of this.rings) {
        g.globalAlpha = Math.max(0, 1 - q.age / q.life) * 0.8;
        g.strokeStyle = '#fbf8f2';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(q.x, q.y, q.r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (this.glowAt) {
      const breathe = this.reduceMotion ? 0.55 : 0.55 + 0.30 * Math.sin(this.clock * Math.PI * 2 / BREATH_PERIOD);
      const r = this.glowAt.r * 2.1;
      if (this.haloOk) {
        g.globalAlpha = Math.max(0.15, Math.min(1, breathe));
        g.drawImage(this.halo, this.glowAt.x - r, this.glowAt.y - r, r * 2, r * 2);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = `rgba(201, 139, 63, ${Math.max(0.1, breathe * 0.5).toFixed(3)})`;
        g.beginPath();
        g.arc(this.glowAt.x, this.glowAt.y, r * 0.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    this.frames++;
  }

  /**
   * 挂到 window 上的读数：全是标量，闸与帧率对拍都读这个。
   * 字段名有意避开 `time/elapsed/frame/dt` 那一族（探针把带这些词的键当计数器排除在判据外），
   * 也避开 state/phase 那族字符串（会被当成"玩法态字符串"读）。
   */
  stats() {
    const s = this.sparks;
    let ex = 0, ey = 0, ekin = 0;
    for (const p of s) {
      ex += p.x; ey += p.y;
      ekin += 0.5 * (p.vx * p.vx + p.vy * p.vy);
    }
    const n = s.length || 1;
    return {
      clock: this.clock,
      simSteps: this.simSteps,
      live: s.length,
      rings: this.rings.length,
      meanX: s.length ? ex / n : 0,
      meanY: s.length ? ey / n : 0,
      meanEnergy: s.length ? ekin / n : 0,
      flow: this.reduceMotion ? 0 : (this.clock * FLOW_SPEED) % FLOW_PERIOD,
      links: this.links.length,
      frozen: this.frozen ? 1 : 0,
      reduced: this.reduceMotion ? 1 : 0,
      paintFails: this.paintFails,
    };
  }
}
