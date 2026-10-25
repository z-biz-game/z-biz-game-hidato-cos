/**
 * 触觉分级 —— z-biz-game-lead/005_技术架构/003_Web端设计系统与精致化标准.md §0 的 web 落地。
 *
 * ⚠️ **触觉是补路，不是主路。**
 *    `navigator.vibrate` 在 **iOS Safari 上不存在**；桌面 Chrome 支持但需用户交互激活，
 *    且多数场景体感很弱。所以：**视觉与听觉必须先到位**，触觉只是加分的第三路。
 *    报告「反馈密度达标」时不能拿 vibrate 顶替视觉/听觉。
 *
 * 分级：
 *    落子 tap    8ms
 *    正确 correct 26ms
 *    错误 wrong  [14, 40, 14]
 *
 * 用法：
 *    import { haptics } from './haptics.js';
 *    haptics.tap(); haptics.correct(); haptics.wrong();
 */
export const HAPTIC_PATTERNS = {
  tap: 8,
  correct: 26,
  wrong: [14, 40, 14],
};

export function createHaptics({
  vibrate = typeof navigator !== 'undefined' ? navigator.vibrate : null,
  userActivation = typeof navigator !== 'undefined' ? navigator.userActivation : null,
} = {}) {
  let armed = false;

  /** 特性探测：这个浏览器到底有没有 vibrate。iOS Safari 上永远是 false。 */
  function supported() {
    return typeof vibrate === 'function';
  }

  /** 真手势里解锁一次（浏览器要求用户激活）。 */
  function arm() {
    if (armed) return;
    armed = true;
    try {
      vibrate?.call(navigator, 0);      // 0ms 不产生体感，但把「已激活」状态置上
    } catch (_) {
      /* 忽略：探测失败就当不支持 */
    }
  }

  function fire(kind) {
    if (!supported()) return false;
    // 没被真实手势激活过就别响（浏览器会忽略，但也不该假装响过）
    if (userActivation && !userActivation.hasBeenActive) return false;
    const pattern = HAPTIC_PATTERNS[kind];
    if (pattern === undefined) return false;
    try {
      return vibrate.call(navigator, pattern);
    } catch (_) {
      return false;
    }
  }

  return {
    supported,
    arm,
    tap: () => fire('tap'),
    correct: () => fire('correct'),
    wrong: () => fire('wrong'),
  };
}

/** 默认单例：仓内直接 `import { haptics } from './haptics.js'` 即可。 */
export const haptics = createHaptics();

if (typeof window !== 'undefined') {
  // 捕获阶段监听，确保第一次真实手势就能解锁
  window.addEventListener('pointerdown', () => haptics.arm(), { capture: true, passive: true });
  window.addEventListener('keydown', () => haptics.arm(), { capture: true });
}
