// 规则模型 · Hidato（嗨达图；亦作 Hidoku，Gyora Benedek 发明）
//
// 题面（唯一可达的规则出处：Cross+A https://www.cross-plus-a.com/puzzles.htm 与
// /cn/puzzles.htm，检索日期 2026-09-28；hidato.com 只发 Angular 壳、无规则句，
// Wikipedia/Baidu/RosettaCode 当晚从本网络取不到，故此处不引它们的话）：
//   * R×C 格网（本仓出货正方形：5×5 / 6×6 / 7×7，N = 25 / 36 / 49），每格填 1..N 各一次；
//   * 连续两数所在格必须**王式相邻**：共边或共角都算（水平/垂直/斜对，即切比雪夫距离 1）；
//     这是 Hidato 与只用横竖的 Numbrix 的唯一分界（Cross+A 对 Numbrix 原文：
//     "going horizontally and vertically only. Diagonal paths are not allowed"）；
//   * 一部分数预印在格子里 = 线索（given），整题必须**恰好一个**完成；
//   * 1 与 N **永远**是印出来的。Cross+A 原文："In every Hidato puzzle the smallest and the
//     highest number are presented in the grid."
//
// 本文件是"什么算一张合法盘"的**唯一定义**：裁判、两条独立见证、铅笔、出题器、port-check
// 全部从这里读几何与合法性。任何一处另写一份 `max(|Δr|,|Δc|)===1` 都是未来的分歧源。
//
// 数据形状（全仓统一，别处不许自创表示）：
//   givenCell : Int32Array(N+1)，下标 = 数 v∈[1,N]，值 = 该 v 印在哪一格（0..N-1），-1 = 未印。
//               用"值→格"而不是"格→值"，因为约束是沿着**值轴**切的（连续性、把值轴切成 gap
//               段是裁判的全部结构），出题器删线索也是按 v 删的。
//   cellOf    : 同形状的 Int32Array(N+1)，一个**完整解**（v→格）。
//   seq       : Int32Array(N)，seq[d] = 第 d+1 个数所在的格 —— 一条哈密顿路径，即盘的答案。
//   格编号 = r*C + c（行主序）。
//
// 成本口径：一次 `dist(i,j)` 是 O(1) 查表（buildGrid 预摊 N² 切比雪夫距离矩阵）。选型屏量到
// 不可约盘最终裁判 7×7 的 ms 中位 1.16 / p95 2.73 / max 4.76，节点中位 19,619 / max 39,362
// （2026-09-28，loadavg 5.99→6.37）。热循环里如果每次现算 |Δr|、|Δc|，就把它变成逐节点的两次
// 除法、两次取模与分支 —— 那根尾巴是要被 budgetMs 定价的，不能白送。

/**
 * 建几何：邻接表（8 向，越界剔除）+ 全对切比雪夫距离表 + 邻接 0/1 矩阵。
 * NB 的**顺序**是 (dr,dc) 从 (-1,-1) 到 (1,1) 行主序 —— 裁判与见证 B 的枚举序、
 * 因而同一个 seed 解出的第一张盘，都依赖这个顺序，不可重排。
 */
export function buildGrid(R, C) {
  const n = R * C;
  const NB = new Array(n);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const list = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= R || cc < 0 || cc >= C) continue;
      list.push(rr * C + cc);
    }
    NB[r * C + c] = list;
  }
  const DIST = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    const ri = (i / C) | 0, ci = i % C;
    for (let j = 0; j < n; j++) {
      DIST[i * n + j] = Math.max(Math.abs(ri - ((j / C) | 0)), Math.abs(ci - (j % C)));
    }
  }
  const adj = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (const j of NB[i]) adj[i * n + j] = 1;
  return { R, C, n, NB, DIST, adj, dist: (i, j) => DIST[i * n + j] };
}

/** 王式相邻（共边或共角）—— 本仓对"连续两数挨着"的唯一拼写。 */
export function isAdjacent(G, a, b) { return G.adj[a * G.n + b] === 1; }

/** 空题面：N+1 长、-1 填充，下标 0 恒弃用（值域是 1..N）。 */
export function makeGiven(n) { return new Int32Array(n + 1).fill(-1); }

/** 一条答案路径 seq（d→格）摊成值→格数组。 */
export function cellOfFromSeq(seq, n) {
  const cellOf = new Int32Array(n + 1);
  for (let v = 1; v <= n; v++) cellOf[v] = seq[v - 1];
  return cellOf;
}

/** 把一条答案路径当成"全印出来的题面"（出题流水线的起点：整盘已知，再往下挖）。 */
export function givensFromSeq(seq, n) {
  const given = makeGiven(n);
  for (let v = 1; v <= n; v++) given[v] = seq[v - 1];
  return given;
}

export function countGivens(given) {
  let k = 0;
  for (let v = 1; v <= given.length - 1; v++) if (given[v] >= 0) k++;
  return k;
}

// ── 端点不变量 ──────────────────────────────────────────────────────────────
// 1 和 N 必须留在题面上。先说清楚**它不是**定理，因为这一族的正确推理容易写歪：
//   对合 k → N+1−k（把同一条几何路径倒着编号）把"合法填法"映到"合法填法"，但它同时也把
//   **题面**换了：印在格 d 的数 v 在对合下变成"N+1−v 印在格 d"。所以镜像解仍是**同一张盘**
//   的解，当且仅当线索集对那个对合封闭。于是：
//     * 线索集封闭 ⇒ 解成对出现 ⇒ 永不唯一（空线索集是它的平凡情形）；
//     * 只印一个端点 **就已经**破掉封闭性（对合要把 N 印在 1 所在的那格，而 N 没印）；
//     * 两个端点都不印 ≠ 不唯一：只要内部有一条 v 使得 N+1−v 没印在同一格，对称就破了。
//       "两端点都没印所以必然多解"这种写法是错的，别在注释里把它当依据（本文件旧版就这么错过）。
//   真正的依据是成例 + 免费的对合破除：Cross+A 原文（见文件头）规定两端都印，而两端齐印是
//   **无条件**封闭性破坏（1 与 N 必在不同格，对合要求它们互换），跟内部线索长什么样无关；
//   同时玩家永远知道链条的两头在哪儿，这是这一族盘子的读法本身。
// 所以挖线索的循环从 v=2 起、到 v=N−1 止，端点**根本不进候选池**，而不是"试删后被裁判否决"。
// 代价是被量到的：单独删掉一个策略锁住的端点后**仍然唯一**的探针是 6/80、4/80、9/80
// （5/6/7 档，分母 = 40 张盘 × 2 个端点，_tmp-hidato-screen.out.txt 的 lockedRedundant，
// 2026-09-28，loadavg 5.99→6.37）——即偶尔确实多印一条。
// 两端点**一起**删掉之后还剩多少盘仍唯一（对合被内部线索破掉的比例），见 tools/balance.mjs 的
// E2 段读数与 docs/DESIGN.md §2；那个实验就是为了让这句话有证人而不是有修辞。
export function endpoints(n) { return [1, n]; }
export function isLockedGiven(v, n) { return v === 1 || v === n; }
/** 可挖线索的值集合（2..N−1）；端点在这里就被排除，见上。 */
export function droppableValues(n) {
  const out = [];
  for (let v = 2; v < n; v++) out.push(v);
  return out;
}

/**
 * 合法盘的唯一定义（独立于两条计数器，逐条读题面）：返回 'ok' 或第一个破坏点的字符串。
 *   not-a-permutation : 1..N 每数占一格、格不重复（即 N 个数落成 N 格的一个排列）
 *   given-violated    : 印出来的数必须在自己那格
 *   adjacency-fail@v  : v 与 v+1 所在格切比雪夫距离恰为 1
 * 'adjacency-fail@v' 里带 v，是为了门禁失败时能一眼看出断在值轴的哪一段，不必再调试一遍。
 */
export function verifyNumbering(G, givenCell, cellOf) {
  const { n, DIST } = G;
  const seen = new Uint8Array(n + 1);
  for (let v = 1; v <= n; v++) {
    const c = cellOf[v];
    if (c < 0 || c >= n || seen[c]) return 'not-a-permutation';
    seen[c] = 1;
    if (givenCell[v] >= 0 && givenCell[v] !== c) return 'given-violated';
  }
  for (let v = 1; v < n; v++) if (DIST[cellOf[v] * n + cellOf[v + 1]] !== 1) return 'adjacency-fail@' + v;
  return 'ok';
}

/** 布尔读法：只做 verifyNumbering 的等值包装，不再写第二份约束。 */
export function isLegalNumbering(G, givenCell, cellOf) {
  return verifyNumbering(G, givenCell, cellOf) === 'ok';
}

/** 题面本身是否自相矛盾（同一格印两个数 / 相邻两端点距离不对）。 */
export function givenConflict(G, givenCell) {
  const { n, dist } = G;
  const used = new Uint8Array(n);
  for (let v = 1; v <= n; v++) {
    const c = givenCell[v];
    if (c >= 0) { if (used[c]) return 'duplicate-given-cell'; used[c] = 1; }
  }
  for (let v = 1; v < n; v++) {
    if (givenCell[v] >= 0 && givenCell[v + 1] >= 0 && dist(givenCell[v], givenCell[v + 1]) !== 1) return 'given-adjacency';
  }
  return null;
}

/** 档位标识 → 格网。出货表在 generate.js 的 TIERS 里，几何只在这里落地。 */
export function gridOf(R, C) {
  if (!(Number.isInteger(R) && Number.isInteger(C) && R >= 3 && C >= 3)) throw new Error(`格网太小，装不下唯一性话题面：${R}x${C}`);
  return buildGrid(R, C);
}

/** '7x7' 这种尺寸串的解析处；TIERS 的键、seed 串里的 size、页面下拉框共用同一个语法。 */
export function parseSize(size) {
  if (typeof size === 'object' && size !== null && Number.isInteger(size.R) && Number.isInteger(size.C)) return size;
  const m = /^([0-9]+)x([0-9]+)$/.exec(String(size).trim());
  if (!m) throw new Error(`尺寸标识不合规（要 'RxC'）：${size}`);
  return { R: Number(m[1]), C: Number(m[2]) };
}

/**
 * 线索的对外形状 → givenCell。三处调用方（裁判、铅笔、页面）必须能吃到同一种写法，
 * 否则"我这边是 {v,cell} 数组、你那边是 Int32Array"会在某个闸里静默变成少一条线索。
 * 允许：Int32Array(N+1)（原样用，不复制，热路径上省一次分配）／{v,cell} 数组／[v,cell] 数组。
 */
export function toGivenCell(G, clues) {
  const { n } = G;
  if (clues instanceof Int32Array) {
    if (clues.length !== n + 1) throw new Error(`givenCell 长度 ${clues.length}，应为 ${n + 1}`);
    return clues;
  }
  if (!Array.isArray(clues)) throw new Error(`线索形状不认识（给 Int32Array 或 {v,cell}[]）：${clues}`);
  const given = makeGiven(n);
  for (const c of clues) {
    const v = Array.isArray(c) ? c[0] : c.v;
    const cell = Array.isArray(c) ? c[1] : c.cell;
    if (!(Number.isInteger(v) && v >= 1 && v <= n)) throw new Error(`线索的值越界：${v}（值域 1..${n}）`);
    if (!(Number.isInteger(cell) && cell >= 0 && cell < n)) throw new Error(`线索的格越界：${cell}（格号 0..${n - 1}）`);
    if (given[v] >= 0 && given[v] !== cell) throw new Error(`同一个值印在两格：v=${v} → ${given[v]} 与 ${cell}`);
    given[v] = cell;
  }
  return given;
}

/** givenCell → 可序列化的线索数组（页面与 JSON 落盘用这个，别把 Int32Array 直接 JSON.stringify）。 */
export function fromGivenCell(given) {
  const out = [];
  for (let v = 1; v < given.length; v++) if (given[v] >= 0) out.push({ v, cell: given[v] });
  return out;
}

/** 端点没印全的缺口（'both' | 'one' | null）—— 见上面端点不变量那一整段。 */
export function missingEndpoints(G, given) {
  const one = given[1] >= 0, last = given[G.n] >= 0;
  if (one && last) return null;
  return one || last ? 'one' : 'both';
}

/** 把题面转成"人读的棋盘"：每格的值或 -1。格 → 值的反查是全仓唯一的这一份。 */
export function valueOfCell(G, given) {
  const out = new Int32Array(G.n).fill(-1);
  for (let v = 1; v <= G.n; v++) if (given[v] >= 0) out[given[v]] = v;
  return out;
}

