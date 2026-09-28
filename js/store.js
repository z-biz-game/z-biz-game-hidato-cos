// 存档 · Hidato（唯一的 localStorage 键）
//
// 口径钉死：这个键里只准有 **seed + 玩家自己写的数 + 步数**，绝不许有答案字段。
// 理由不是洁癖：本仓的盘是 seed 的纯函数，存档里带答案等于把裁判证出来的那条链发进浏览器存储，
// 而浏览器闸要断言"存档里没有答案"（它拿 node 侧算出的真值串来扫 localStorage 与对象图）。
// 写盘按**字段白名单**挑，不按"删掉不该有的"—— 白名单不会把未来的答案字段顺手带出去。
//
// 键形状：`hidato.save.v1`，值：{"v":1,"tier":"5x5","seed":"h0","entries":"00e1…","steps":7,"hints":2}
// entries 是**每格两个十六进制位**的拼接（`00` = 该格空着且没印），长度 = 2 × 格数；
// 印着的格在 entries 里恒为 `00`（题面由 tier+seed 现算回来，存档不重复它，也就没机会抄答案）。
// 任何一个字段读不出来 ⇒ 当作没有存档：半截 entries 会画出一张鬼盘。

export const SAVE_KEY = 'hidato.save.v1';
export const SAVE_FIELDS = Object.freeze(['v', 'tier', 'seed', 'entries', 'steps', 'hints']);

/** 存档里出现答案字段的名字 ⇒ 闸红。这里给闸一个单点定义，不散在正则里。 */
export const ANSWERISH = /(truth|solution|answer|pos\b|assign|dom\b)/i;

/** 每格 → 2 位十六进制（0 = 空）。值域最大 49（7×7），两个十六进制位足够。 */
export function encodeEntries(values) {
  let s = '';
  for (let c = 0; c < values.length; c++) s += (values[c] >>> 0).toString(16).padStart(2, '0');
  return s;
}

/** 2 位十六进制 → 每格一个数；形状不对就交回 null（调用方决定怎么处理，这里不猜）。 */
export function decodeEntries(str, n) {
  if (typeof str !== 'string' || str.length !== 2 * n || !/^([0-9a-f]{2})*$/.test(str)) return null;
  const out = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    const v = parseInt(str.substr(c * 2, 2), 16);
    if (!(v >= 0 && v <= n)) return null;                     // 越界的数 = 不是这张盘的档
    out[c] = v;
  }
  return out;
}

/** 只从白名单里取字段；取不到就是没有存档（不猜、不补默认值）。 */
export function pack(state) {
  const out = { v: 1, tier: String(state.tier), seed: String(state.seed), entries: String(state.entries) };
  out.steps = Number.isFinite(state.steps) ? state.steps : 0;
  out.hints = Number.isFinite(state.hints) ? state.hints : 0;
  return out;
}

export function save(store, state) {
  try {
    store.setItem(SAVE_KEY, JSON.stringify(pack(state)));
    return true;
  } catch {
    return false;                       // 无痕模式 / 配额爆：静默继续玩，但不假装存住了
  }
}

/** 读档：结构不对就当作没有，绝不返回半截状态。entries 的语义合法性由 ui/game.js 的 decode 验。 */
export function load(store) {
  let raw = null;
  try {
    raw = store.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || obj.v !== 1) return null;
  if (typeof obj.tier !== 'string' || typeof obj.seed !== 'string' || typeof obj.entries !== 'string') return null;
  if (!/^[0-9a-f]*$/.test(obj.entries) || obj.entries.length % 2 !== 0) return null;
  if (!Number.isFinite(obj.steps) || !Number.isFinite(obj.hints)) return null;
  return { v: 1, tier: obj.tier, seed: obj.seed, entries: obj.entries, steps: obj.steps, hints: obj.hints };
}

export function clear(store) {
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
