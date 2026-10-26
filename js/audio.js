/**
 * 合成短音 —— z-biz-game-lead/005_技术架构/003_Web端设计系统与精致化标准.md §0 的 web 落地。
 *
 * 不用音频文件：Web Audio 直接合成短音，零资源、零加载、可分级。
 * 分级表（type/freq/to/dur/gain）与组织标准 §0 的反馈分级一一对应。
 *
 * 三条硬规矩：
 *  ① **AudioContext 只能在真实手势里创建/恢复**（浏览器自动播放策略）。
 *     仓内做法：在 pointerdown / keydown 的捕获阶段调 `audio.unlock()`。
 *  ② **真静音 = 挂起整个 AudioContext**（`ctx.suspend()`），
 *     不是把 master.gain 拧到 0 —— 只拧 gain 是假静音：节点照建、时钟照跑，
 *     取消静音还有尾巴。
 *  ③ **没解锁就不发声**：`play()` 在真实手势之前直接返回 false，一个节点都不建。
 *     建了也响不了（上下文是挂着的），还会在恢复的那一刻集体补响一遍。
 *
 * 用法：
 *    import { audio } from './audio.js';
 *    audio.unlock();            // 第一次真实手势里调一次
 *    audio.play('correct');
 *    audio.setMuted(true);      // 真静音
 */

// 音效开关是**界面偏好**，不是成绩：单开一个键，不混进存档的版本号里，
// 免得以后升存档格式时把这条偏好一起丢掉。
const PREFS_KEY = 'hidato.audio.v1';

export const VOICES = {
  tap:     { type: 'triangle', freq: 520, to: 520, dur: 0.05, gain: 0.14 },
  move:    { type: 'triangle', freq: 300, to: 420, dur: 0.08, gain: 0.12 },
  place:   { type: 'square',   freq: 640, to: 700, dur: 0.06, gain: 0.10 },
  correct: { type: 'sine',     freq: 720, to: 980, dur: 0.09, gain: 0.12 },
  wrong:   { type: 'square',   freq: 150, to: 110, dur: 0.14, gain: 0.11 },
  blocked: { type: 'sawtooth', freq: 120, to: 96,  dur: 0.16, gain: 0.10 },
  win:     { arp: [523, 659, 784, 1047], dur: 0.16, gain: 0.13 },
  lose:    { arp: [392, 330, 262],      dur: 0.20, gain: 0.12 },
};

/** 读一次静音偏好。读不到（隐私模式/被拒）就当"有声音"，不假装读过存档。 */
function readMutedPref() {
  try {
    return window.localStorage.getItem(PREFS_KEY) === '1';
  } catch (err) {
    return false;
  }
}

/** 写静音偏好。写不进去就只是本次会话内有效，不报错、不假装存下了。 */
function writeMutedPref(on) {
  try {
    window.localStorage.setItem(PREFS_KEY, on ? '1' : '0');
  } catch (err) {
    /* 存不下就算了：这一会话里开关照样管用 */
  }
}

/**
 * AudioContext 的 resume()/suspend() 都回 Promise。没人接的拒绝会升级成
 * unhandledrejection，冒到 window.onerror —— 离屏预载时足以把整页判死。
 * 所以一律就地吞掉：声音发不发出去是别的事，不该让整页陪葬。
 */
function quiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

export function createAudio({
  AudioContextCtor = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null,
  muted: initialMuted = false,
} = {}) {
  let ctx = null;
  let master = null;
  let muted = !!initialMuted;
  let unlocked = false;

  function ensure() {
    if (ctx) return ctx;
    if (!AudioContextCtor) return null;
    ctx = new AudioContextCtor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    // 静音期间才建上下文：建完立刻挂起，别让它在静音时还空跑。
    if (muted) quiet(ctx.suspend());
    return ctx;
  }

  /** 在真实手势里调用：创建/恢复 AudioContext。 */
  function unlock() {
    const c = ensure();
    if (!c) return false;
    if (!muted && c.state === 'suspended') quiet(c.resume());
    unlocked = true;
    return true;
  }

  /** 真静音：挂起整个上下文（不是拧 gain）。 */
  function setMuted(on) {
    muted = !!on;
    writeMutedPref(muted);
    const c = ctx;
    if (!c) return;
    if (muted && c.state === 'running') quiet(c.suspend());
    if (!muted && c.state === 'suspended' && unlocked) quiet(c.resume());
  }

  function blip(voice, when = 0) {
    const c = ensure();
    if (!c || muted) return;
    if (c.state === 'suspended' && unlocked) quiet(c.resume());
    const t0 = c.currentTime + when;
    if (voice.arp) {
      voice.arp.forEach((f, i) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, t0 + i * voice.dur * 0.55);
        g.gain.setValueAtTime(0, t0 + i * voice.dur * 0.55);
        g.gain.linearRampToValueAtTime(voice.gain, t0 + i * voice.dur * 0.55 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * voice.dur * 0.55 + voice.dur);
        osc.connect(g); g.connect(master);
        osc.start(t0 + i * voice.dur * 0.55);
        osc.stop(t0 + i * voice.dur * 0.55 + voice.dur + 0.02);
      });
      return;
    }
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = voice.type || 'sine';
    osc.frequency.setValueAtTime(voice.freq, t0);
    if (voice.to) osc.frequency.linearRampToValueAtTime(voice.to, t0 + voice.dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(voice.gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + voice.dur);
    osc.connect(g); g.connect(master);
    osc.start(t0);
    osc.stop(t0 + voice.dur + 0.02);
  }

  /**
   * 放一个音。返回 false 表示**这一声没发出去**（音名不认识、还没被真实手势解锁，
   * 或此刻是静音态 —— 静音时 blip() 一个节点都不建，那就不能回 true 说响过了）。
   * 调用方据此知道"这一路反馈没有"，而不是以为响过了。
   */
  function play(name) {
    const voice = VOICES[name];
    if (!voice) return false;
    if (!unlocked) return false;   // 规矩③：没解锁就不建节点
    if (muted) return false;       // 静音 = 挂起：这一声同样没发出去
    blip(voice);
    return true;
  }

  return {
    unlock,
    play,
    setMuted,
    get muted() { return muted; },
    get unlocked() { return unlocked; },
  };
}

/** 默认单例。 */
export const audio = createAudio({
  muted: typeof window !== 'undefined' ? readMutedPref() : false,
});

// 测试环境的假 window 不一定有 addEventListener（node 里手搓的桩）：有才挂，
// 少这两个监听只是"没有自动解锁"，不该让整个模块 import 阶段就炸。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pointerdown', () => audio.unlock(), { capture: true, passive: true });
  window.addEventListener('keydown', () => audio.unlock(), { capture: true });
}
