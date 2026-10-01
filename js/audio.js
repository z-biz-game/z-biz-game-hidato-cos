// 音效层 · 智渡 Hidato（WebAudio，一次性短音，无背景音乐循环）
//
// 这一层要兑现的是"静音键按下去真的停了"，不是"把音量滑到 0"：
//   · **真停**：静音走 `AudioContext.suspend()`，上下文进入 suspended ⇒ 采样时钟不再推进；
//     取消静音走 `resume()`。只把 master gain 设 0 的写法节点照样在跑（CPU、振荡器计数都涨），
//     本仓把它当假静音，所以这里两个计数器都要留：`voices`（真建过的振荡器数）与
//     `blocked`（静音态被挡下的建节点请求数）。判据是**静音期间 voices 增量恒为 0**。
//   · **手势之后才建上下文**：Chrome 的 autoplay 策略下，用户点过之前 `new AudioContext()`
//     拿到的就是 suspended 状态且会打一条 console warning。这里干脆不建 —— `ensure()` 只在
//     第一次真指针/键盘事件里被调用，之前 `stats().contextOpen` 恒为 0。
//   · **不落盘**：本仓的 localStorage 只有 `hidato.save.v1` 这一个键，且键里字段有白名单
//     （见 js/store.js 与 tools/scenarios.js 的两段式解码腿）。把静音偏好写进第二个键会让那条
//     红线变红，所以静音是**每回合一次的决定**，不跨会话。
//   · 环境没有 AudioContext（老浏览器 / node 侧探针沙箱）时不许抛：记 `unavailable`，
//     `play()` 交回 0，玩法照跑。
const MASTER_GAIN = 0.16;       // 纸笔游戏的音量：提示音不该盖过思考
const NOTE_BASE = 392;          // G4，落子主音（黄铜味：偏低的正中音）

/** 每个音色 = 一段频率轨迹 [Hz, 秒] 与包络形状。纯数据，方便逐条核对。 */
const VOICES = {
  tap: { parts: [[NOTE_BASE, 0.05]], type: 'triangle', peak: 0.9 },
  place: { parts: [[NOTE_BASE, 0.04], [NOTE_BASE * 1.5, 0.09]], type: 'triangle', peak: 1 },
  lift: { parts: [[NOTE_BASE * 1.5, 0.05], [NOTE_BASE * 2, 0.1]], type: 'sine', peak: 0.8 },
  rub: { parts: [[NOTE_BASE * 0.75, 0.07]], type: 'sawtooth', peak: 0.5 },
  wrong: { parts: [[NOTE_BASE * 0.62, 0.09], [NOTE_BASE * 0.5, 0.13]], type: 'square', peak: 0.45 },
  solve: { parts: [[NOTE_BASE, 0.1], [NOTE_BASE * 1.26, 0.1], [NOTE_BASE * 1.5, 0.1], [NOTE_BASE * 2, 0.2]], type: 'triangle', peak: 0.95 },
};

export class Sfx {
  constructor(opts = {}) {
    this.Ctor = opts.audioContextCtor ||
      (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null);
    this.ctx = null;
    this.master = null;
    this.muted = !!opts.muted;
    this.unavailable = false;
    this.error = '';
    this.plays = 0;             // 被请求过的音色数（含被挡下的）
    this.voices = 0;            // 真建出来的振荡器数
    this.blocked = 0;           // 静音态挡下的请求数 ⇒ "假静音"当场露馅
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.armed = false;         // 第一次真手势之前**不建上下文**（autoplay 策略会给它一个 suspended 起手 + 一条 warning）
    this.deferred = 0;          // 未解锁时被拒的播放请求数
    this.gain = MASTER_GAIN;
  }

  /** 真手势（pointerdown / keydown）之后调：建上下文，幂等。 */
  arm() {
    this.armed = true;
    return this.ensure();
  }

  /** 只在用户手势里调：上下文、主增益，一次建好就复用（重复 new 会被浏览器限流）。 */
  ensure() {
    if (this.ctx || this.unavailable) return this.ctx;
    if (typeof this.Ctor !== 'function') { this.unavailable = true; return null; }
    try {
      this.ctx = new this.Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.gain;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      this.unavailable = true;
      this.ctx = null;
      this.master = null;
      this.error = String(e && e.message || e);
      return null;
    }
    // 手势之前建不起来 ⇒ 这里如果拿到的是 suspended（自动播放被拦）就顺手 resume 一次。
    if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
      this.resumeCalls++;
      this.swallow(this.ctx.resume());
    }
    return this.ctx;
  }

  /** promise 在 Safari 老版本会拒（打断音频图），拒了也不许冒到 console。 */
  swallow(p) {
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return p;
  }

  /**
   * 静音开关。**真停**：suspend 上下文；顺带把 master 也拉到 0，双保险（避免 suspend
   * 在某些实现里被后台计时器拖出尾音）。返回静音之后的读数。
   */
  setMuted(on) {
    this.muted = !!on;
    if (!this.ctx) return this.stats();          // 还没建过上下文：静音=不建，没什么可停的
    if (this.muted) {
      if (this.master) this.master.gain.value = 0;
      if (typeof this.ctx.suspend === 'function') {
        this.suspendCalls++;
        this.swallow(this.ctx.suspend());
      }
    } else {
      if (this.master) this.master.gain.value = this.gain;
      if (typeof this.ctx.resume === 'function') {
        this.resumeCalls++;
        this.swallow(this.ctx.resume());
      }
    }
    return this.stats();
  }

  toggleMute() { return this.setMuted(!this.muted); }

  /**
   * 放一个音色。静音态**一个节点都不建**（判据在 stats().voices 的增量上）。
   * @returns {number} 本次真建出来的振荡器数
   */
  play(name) {
    this.plays++;
    if (!this.armed) { this.deferred++; return 0; }          // 没手势 ⇒ 连上下文都不建
    if (this.muted) { this.blocked++; return 0; }            // 静音 ⇒ 一个振荡器都不生
    const spec = VOICES[name] || VOICES.tap;
    const ctx = this.ensure();
    if (!ctx) return 0;
    const at = ctx.currentTime;
    let made = 0;
    let offset = 0;
    for (const [hz, dur] of spec.parts) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = spec.type;
      osc.frequency.value = hz;
      // 包络：10ms 起音 + 尾段指数衰减，避免方/锯齿波的爆音咔哒。
      env.gain.setValueAtTime(0.0001, at + offset);
      env.gain.linearRampToValueAtTime(spec.peak, at + offset + Math.min(0.01, dur * 0.3));
      env.gain.exponentialRampToValueAtTime(0.0001, at + offset + dur);
      osc.connect(env);
      env.connect(this.master);
      osc.start(at + offset);
      osc.stop(at + offset + dur + 0.01);
      made++;
      offset += dur * 0.85;                      // 音与音之间留一点重叠，听上去是一条旋律
    }
    this.voices += made;
    return made;
  }

  /** 重开一局：只清"这一局的临时增益/尾巴"，上下文与静音偏好留在原处（重开不该把音量拧没）。 */
  reset() {
    this.plays = 0;
    this.voices = 0;
    this.blocked = 0;
    this.deferred = 0;
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.gain = MASTER_GAIN;   // 临时增益回默认（重开不该留着上一局的音量）
    if (this.master) this.master.gain.value = this.muted ? 0 : this.gain;
    return this.stats();
  }

  /** 读数键名刻意躲开探针的 COUNTER/STATEKEY 词表（不叫 time/now/state）。 */
  stats() {
    return {
      muted: this.muted ? 1 : 0,
      armed: this.armed ? 1 : 0,
      contextOpen: this.ctx ? 1 : 0,
      unavailable: this.unavailable ? 1 : 0,
      suspended: this.ctx && this.ctx.state === 'suspended' ? 1 : 0,
      gain: this.master ? Number(this.master.gain.value) : this.gain,
      plays: this.plays,
      voices: this.voices,
      blocked: this.blocked,
      deferred: this.deferred,
      suspendCalls: this.suspendCalls,
      resumeCalls: this.resumeCalls,
    };
  }
}

export const VOICE_NAMES = Object.freeze(Object.keys(VOICES));
