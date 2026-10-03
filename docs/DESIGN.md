# DESIGN · 智渡 Hidato（给下一个接手的人）

本文件只指**符号名与文件名**，不指行号：行号是证据，插一行注释就漂一批，漂掉的引用比没有引用更坏。
文中所有墙上读数都标了「本机某日的一次观测 + 复跑命令」；数字不是契约，**闸的退出码才是契约**。

## 1. 出题管线全链

一条盘走五步，每步都留账，全在 `js/engine/generate.js`：

1. **抽答案 = 一条哈密顿路径**（不是题面）：`samplePath` 默认走 `sampler:'biased'`，即随机化的 Warnsdorff
   —— 候选按「前向度最少」先试，**同前向度的随机键在 `sort` 之前就抽好**（比较器不吃随机数），
   尾数按格号兜底。`sampleHamiltonPath`（朴素版）仍然留着：换采样器等于换一批盘，要能对的账就得能重跑另一条。
   节点闸是 `SAMPLE_NODE_CAP`，每次抽取失败就重抽，次数记在 receipt 的 `draws`（`TIERS.attempts` 就是给它定价的）。
2. **挖线索到逐条不可约**：`carveIrreducible` 按 `shuffled(droppableValues(n))` 的序逐个试删 2..N−1，
   删掉后 `countSolutions` 交回 `outcome==='unique'` 才真删；否则把那条线索**放回去**。
   探针预算 `CARVE_PROBE`（nodeCap 40000 / msCap 60）比出货裁判小一个数量级，因为一盘要试 n−2 次。
   被预算掐停（`outcome==='stopped'`）的那条记作 `keptByBudget`（另有一笔 `keptByMultiple`）——
   这两件事**必须分开记账**：「删了会多解」是事实，「来不及证伪」不是事实，只是没测完。
   方向安全：击穿只会让题面更密，绝不会少印。端点 1 与 N 根本不进候选池（成例策略，理由见
   `js/engine/rules.js` 的「端点不变量」一节；两端都不印仍可能唯一，`tools/rule-test.mjs` 有这一条读数）。
3. **证书裁判**：不可约盘整盘再判一次（出货预算 `TIERS.nodeCap` / `budgetMs`），交回 `ref`。
   这一趟就是"这张题面被证明恰好一解"的证书 —— 而它**只属于证书盘**。
4. **密度梯**：`ladderRungs` 沿 `dropOrder` 的逆序逐层把线索放回去，**取第一个 `pencilSolve(..., 'BASIC')`
   推得完的层**就停（`shipIdx`）。调用方不许退到"整盘印出来"那一层：那是零推理的废话盘，承诺直接归零。
   `opts.walkAll` 只有闸用（难度轴单调性要在整条梯上读，生产的成本口径不是走完的）。
5. **出货档裁判**：对梯上那一层再判一次唯一性，`solutionCellOf` 优先取**裁判带回来的**那个解
   （拿 `path` 当答案去自证 = 把出题器记的账当证人）。

出货入口是 `generate(tierKey, seed)`（预算一律从 `TIERS` 来，自带参数＝重新定价）；
`produce(tierKey, seed)` 只出证书盘、不走梯，它**不是**出货路径（那种盘命名铅笔推不完）。
`generateOn` 的 fail 只有 `path` / `cert-*` / `ladder` / `ship-*` 四类，各记各的账、一个都不重试 ——
`ship-*` 按构造不可能成立，出现就是梯子或裁判坏了，必须红，不许在这儿悄悄换 seed 再抽一张。

**QA 的 `confirm` 不进定价。** `produceBoard` 第 3 步之后可以对每条幸存线索做一次"删了还唯一吗"的复核，
但 `generateOn` 默认不跑它。本机 2026-09-29 一次 `SAMPLES=24 node tools/balance.mjs` 的 7×7 段把这件事量得很直白：
含 QA 复核的整盘生产墙钟中位 43.82 ms，不含 QA 的中位 10.63 ms（复跑：`SAMPLES=24 node tools/balance.mjs`）。
QA 是**闸的批量读数**，`tools/balance.mjs` 已经在闸里批量买过一次；把它的成本算进出货预算会把 `TIERS` 定贵，
反过来把 QA 读数当出货读数会把红线定松。`produce()` 里 `confirm` 默认 `true`，因为那条路径就是给 R5/E 红线看的。

## 2. 两套互不信任的复核（外加第三套）

- **允许搜索的那条**：`js/engine/counter.js` 的 `countSolutions` —— 传播引导的穷举计数器。
  线索把值轴切成 gap，MRV 选 gap，带三种剪枝（距离上界、corridor 体积、锚点距离）。
  三态出口 `unique` / `multiple` / `none` / `stopped`，`provesUnique` 显式排除 `stopped`。
- **不允许搜索的那条**：`js/engine/pencil.js` 的 `pencilSolve` + 命名规则表（`RULE_NAMES` / `BASIC_RULES` /
  `EXT_RULES` / `RULE_ORDER`），几何与合法性只从 `js/engine/rules.js` 读。每次开火都能点名（`ruleFires`），
  `auditAgainst` 把每条结论拿去对真值。
- **第三条**：`js/engine/witness.js` 的 `countWitnessB`（与 `countWitnessA`）—— **不给任何剪枝**、
  gap 固定升序（绝不 MRV）、不设距离下界，只判**题面本身**：连续两印必须王步相邻、每格一个数、最后落回远端锚点。
  它慢裁判一到两个数量级，所以用于抽样复核；`stopped` 在它这里读作"没有读数"，既不算一致也不算分歧
  （把它算成分歧会制造假不一致）。

**为什么不许把推理规则塞进计数器，也不许两者共享规则表**：唯一性承诺的全部内容就是"两条独立的路线给出同一个读数"。
计数器一旦复用铅笔的规则表，铅笔删剩的东西就成了计数器的剪枝，两条路线塌回一条 —— 那就不再是对账，
而是同一个实现自己给自己作证。所以 `witness.js` 文件头就把话说死：不复用 `counter.js` 的任何东西
（没有 gap 描述子、没有 MRV、没有 corridor 体积），只共享 `rules.js` 里那份几何 —— **那是题面本身，不是剪枝**。

## 3. 确定性教义

`seed` 决定一切 ⇒ 任何一次随机数抽取的**次数**只能取决于输入，不许取决于 `sort` 的比较次数
（比较器里抽随机数＝node 与 Chrome 画两张盘）。这就是 `sampleHamiltonPathBiased` 把同前向度的随机键
在排序之前抽好的全部理由。所有随机流都从 seed 串派生（`js/engine/rng.js` 的 `makeRng`），没有任何一路来自
时钟、日期或环境；页侧同样由 `js/main.js` 不碰时钟来兑现（`DEFAULT_SEED` 是串常量，不是当天第几张盘）。

- `nodeCap` 掐停是**纯函数**且方向安全：节点数只取决于输入，击穿只让题面更密。
- `msCap` 掐停**会让盘形跟着机器速度变** ⇒「ms 闸没参与判定」是红线。
  `tools/balance.mjs` 的 G2 把生产路径每一次击穿按闸归因，归到 `msCap` 的一律红；
  归因由 `counter.js` 的 `stoppedBy` 字段交回。页侧证人是 `window.hidato.state().proof.stoppedByMs` /
  `stoppedByNodes`（`js/main.js` 的 `state()` 把 `makeBoard` 那份 watch 计数原样交出来），
  浏览器闸拿它断言"这一跑没有任何一次判定是被毫秒掐掉的"。
  本机 2026-09-29 `SAMPLES=24 node tools/balance.mjs`：三档击穿 1 / 10 / 39 次，按闸归因全是 nodes，
  ms 与 unknown 都是 0（复跑同一条命令，看每档「击穿 … 按闸」那一行）。
  余量最薄的是 7×7：同一次观测里生产路径单次裁判 ms 中位 0.01 / p95 1.63 / max 4.79，而 `budgetMs=10`。
  慢一倍的机器会真的触发 ms 闸，届时 G2 直接红，那一档必须重测，不许把这里的 10 抄过去当结论。
  **G2 当时看不见那件事**（2026-10-04 修）：`tools/balance.mjs` 的归因账本是在 `if (!out.ok) continue`
  *之后*才累加的，而被毫秒掐掉的盘正是那张会 `continue` 的盘——同一次 run 里 A 打「cert 失败 1」、
  G2 打「msCap 0 次」（红线绿着，出货已经少了一张）。G3 的两条独立记账也各丢同一张盘，于是"相等"
  是恒等的。现在没出货的盘也数归因（只数归因：被掐停的半截 ms 读数不进定价分位表，那是机器的读数
  不是题面的读数），`cert 失败` 的 detail 按闸分账 ms／nodes／没被掐。
  可复现条件写在代码注释里，一句话：把这一个进程的 `performance.now()` 走快 3 倍（所有 duration ×3），
  同一条命令就撞出 runner 那形状——**不占 CPU**，满载复现不出这条红还污染兄弟 agent 的计时闸。
  治法按本节末的口径：7×7 的 `budgetMs` 在那条慢钟上重测尾巴，`10 → 20`（同一条公式，p95 4.57×4 上取；
  5×5／6×6 在同一条慢钟下 max 2.16／5.79，仍回到 10）。同一趟的**节点**读数与真钟逐位相同
  （每盘调用 25/36/49 次、单次节点 p95 1,028/7,951/26,543、max 40,001），这就是"挂钟会改盘、节点数不会"。
  **这件事已经真发生过一次**，在 CI 的 runner 上（node 20）：`tools/pencil-test.mjs` 的证书盘取样红在
  `produce 7x7#5 :: cert-stopped · 归因=ms nodes=36608 ms=10.08 · 预算 nodeCap=250000/msCap=10 · 线索 16`
  （那一行原样在 run log 里；同一串 seed 在本机 node 26 的证书裁判是 37239 节点 / 4.15 ms）。
  两个读数一起说明两件事：runner 的 node 侧裁判大约是这台笔记本的 2.4 倍慢，**而且** carve 的 60 ms 探针
  在那边放回了不同数量的线索（16 条、36608 节点 vs 37239 节点）—— 同一 seed 在两台机器上本来就不是同一张盘。
  处置分两条路，一条都没放宽：出货路径继续由 G2 钉"ms 归因 = 0"，那种盘页面**拒收**（`boardIsProven`），
  没证完的不发货；取样路径（`pencil-test` 要的是"能当证人的证书盘"）允许把"这台机器证不完"记成**缺席**，
  但每档至多 `floor(SAMPLES/4)` 张、三种去向（入池／赦／红）必须逐档闭合，`cert-multiple` / `cert-none` /
  归因 `nodes` 一张都不赦。要治红就在那台机器上按第 4 节的口径重测尾巴再回填 `budgetMs`——
  把 `floor(SAMPLES/4)` 调大不是重测。
  **这条判定接上之后的一次 CI 复跑，runner 上一张都没被赦**：`6dc88f2` 那次 push（CI run 36478620986）
  的 check job 三档都打「入池 10 + 这台机器证不完 0 + 红掉 0 = 抽样 10」（复跑：push 后读 check job 里
  「证书盘取样闭合」那三行）。所以 `ms=10.08` 撞 `budgetMs=10` 是同一次 run 的**临界翻转**，不是那个
  runner 摊上的固定开销——一次复跑既不足以说那条红"已被修好"，也不足以说"证不完 2 张是它的常态"；
  上限 2 买到的只有"翻车时不必当场改预算"这一件事。同一次 run 里 balance 的 G2 归因 msCap 0 次
  （三档击穿 1 / 10 / 39 全在 carve、全按 nodes），browser job 两形态各「8/8 legs · 497 checks · 0 failed」。
- 跨引擎对账在 `tools/verify.sh` 的 `crossengine` 腿：18 张出货盘指纹（三档各 6 张），
  node 侧由 `tools/playtest.cjs witness` 算，Chrome 侧页面自己算，逐条比。
  本机 2026-09-29 `bash tools/verify.sh` 实测两种形态都是 `matched: "18/18"`、`chromeMsCapBreaches: 0`
  （`chromeNodeCapBreaches` 是 14 —— 节点闸的击穿是设计内的、方向安全的，所以它只记账不判红）。

## 4. 成本口径

**以 `tools/balance.mjs` 的代码为准重抄口径，别信任何注释（包括本节）。**

- 通用式：`band = [max(1, floor(median × 0.4)), max(lo + 1, ceil(p95 × 1.6))]`，
  `budgetMs = max(10, ceil(p95 × 4 / 10) × 10)`。式子里的 p95 是**那台要跑这条管线的机器**的 p95，
  不是写表那台的——`7×7` 现在是 20，因为它按 CI runner 与"慢 3 倍的钟"这个可复现条件重测过尾巴
  （第 3 节 ms 那一段）；公式一个字符没动，动的量是量出来的那个。
  **毫秒类的尾巴取 p95，不取中位 ×2** —— 出题墙钟在本组织是双峰的，中位 ×2 会把真实尾巴砍在表外。
- 计数的量（每盘裁判调用次数、梯层数、每盘抽取次数）都是**纯函数读数**，没有双峰问题；
  两个数必须纯函数才能当闸。
- 本格网的例外要讲清：**结构恒等式写死**。每盘生产路径裁判调用恰好 (n−2) 次探针 + 1 次证书 + 1 次出货 = n 次，
  所以本仓 `TIERS` 三档的 `band` 就是 `[n, n]`（25 / 36 / 49），**不套通用式** —— 套式子会得到
  带 0.4×/1.6× 余量的区间，等于给一个结构常数凭空留 60% 的漂移口子，管线真的多打一次裁判调用时闸不会响。
  `ladder` 反过来必须留上界余量（层数随盘变，且**变小不是回归**），下界写 1 而不是 0.4×中位。
- `budgetMs` 的口径是「**生产路径上每一次裁判调用**」，不含 QA 复核；`carve` 那一档
  （`CARVE_PROBE` 40000 节点 / 60 ms）**不分档**，因为改它就是改采样语义、会换一批盘，
  而 `tools/port-check.mjs` 的指纹参照物是在这个口径下量出来的。
- `SAMPLES` 下限是 3（`tools/balance.mjs` 直接 `exit 2`）：分位表在 3 个样本以下没有意义。

## 5. 五道闸各测什么、怎么自证它会红

| 闸 | 测什么 | 阴性自证（必须红的那一手） |
| --- | --- | --- |
| `tools/rule-test.mjs` | 规则词表与"什么算合法盘"的独立对照：几何、数据形状、`verifyNumbering` 每条违规一个负样本 + 修好它的正样本、端点三态 | 每个负样本都配一条"把缺陷放回去就绿"的对照，斜禁实现/序被动过都会红 |
| `tools/pencil-test.mjs` | 每条推理都在真值上（`auditAgainst`）、独立见证当证人、七条规则都有出场证人、EXT 不比 BASIC 弱；证书盘取样的三种去向（入池／被这台机器的钟赦掉／红掉）逐档必须闭合，且每档被赦的不许超过 `floor(SAMPLES/4)` | 伪造定值 25 次必须全被抓；关掉任意一条规则终局域只能是超集；**同一个进程里**饿 `TIERS` 的档位预算做两把对照：饿 `budgetMs` ⇒ 只出 `STARVED` 并且红在"饿得太多"，压 `nodeCap` ⇒ 一张都不许被赦（归因是 nodes 就红），两把都必须 rc=1 |
| `tools/port-check.mjs` | 引擎流水线逐字节对回选型屏的 120 张指纹（**本地一次性**，见第 6 节） | 挪动 gap 顺序／洗牌次数／邻接表次序任何一格，指纹就变（条数可能看起来一模一样） |
| `tools/balance.mjs` | 出货路径的三条承诺 + 定价表：红线 A–I（唯一性、答案独立合法、零猜测、见证一致、证书不可约、铅笔健全、G1/G2/G3 预算与确定性、难度轴单调、`TIERS` 覆盖实测） | `SAMPLES` 改小或 `TIERS` 漂了，I 会红；ms 参与判定，G2 会红 |
| `tools/verify.sh` | 真 Chrome、真 DOM、真指针、真焦点、真 localStorage、跨引擎指纹：八条腿 × 两形态 | `SABOTAGE=1`（改错期望：crossengine 指纹 / keyboard 轨迹 / resume 假重载 / narrow 的 dpr / canary 少一张负样本）与 `PLANT_TRUTH=1`（当场把真值种进对象图，落盘扫描必须抓）—— 命令组合列在脚本头部注释 |

**一条闸的诚实性判据是退出码非 0，不是 stdout 上有一行 FAIL。** `tools/verify.sh` 自己就在头部注释里把这条
写成要求（阴性自证那一跑必须"有 FAIL 且退出码非 0"）；少一段腿交回结果也判红（`WANT_N` 由注册表决定，
不是"跑完了就算"）。任何一条红都不许靠调低阈值来治 —— 要么改代码，要么在这里写清前提错在哪。

## 6. 已知边界 / 没接的东西（写现状，不写"已完善"）

- **`tools/port-check.mjs` 不在 CI 里**。它的参照物 `_tmp-hidato-boards.tsv` 按设计放在仓外（`../../`），
  缺了它脚本打印「port-check 跳过」并 `exit 3`。本机 2026-09-29 把仓库复制到没有参照物的相对位置复跑实测到
  rc=3；接成硬步骤就是一条只存在于 CI 且永远红的门，用 `if` 包住它就是一条永远空转的门 —— 两个都不干。
  它是本地一次性端口对账，跑法在 README。
- **第三种 URL 形态（已部署站点）不接 CI**：`BASE_URL=https://z-biz-game.github.io/z-biz-game-hidato-cos/ bash tools/verify.sh`
  目前是**发布后由维护者手跑**，不是每次 push 都跑。理由是 Pages 落地有传播延迟，接进 CI 得到的是一条
  "有时红"的门，而那条红与代码无关。`tools/verify.sh` 头部注释与 `.github/workflows/ci.yml` 的注释都写着同一件事。
- **CI 里没有 `node --test test/`**：本仓 `git ls-files test/` 为空（工作树里那个目录没进 git）。
  单元测试的形状就是三道 node 闸本身。
- **CI 独有门：无。** `.github/workflows/ci.yml` 里每一条 grep 与每一道闸都在本机原样跑过（命令逐条列在
  README「怎么跑」一节，读数在「这一仓敢声称什么」与「CI 与 Pages」两节）。分层不变量那条用的是 import/export 形状的正则，不是"提一句 `tools/` 就算命中"——
  引擎注释里合法地写着 `tools/balance.mjs`、`tools/port-check.mjs`，宽正则会把注释判成分层破坏。
- **入口接线证据不含 canvas**：本仓首页是 DOM 格（`#board` + `role="grid"` + `[data-cell]`），
  `grep -c canvas index.html` 实测 0。任何按画布找的断言在这里都不成立。
- **Pages 站点在首次 deploy 之前是 404**，这是预期，不是 bug。
- **7×7 的 ms 余量最薄**（见第 3 节那次观测）；机器负载高到一定程度时该档需要重测，不要提前放宽。
- **本仓不做 hint 之外的辅助**：`Game.hint()` 只念铅笔删剩的候选，`hintStalls` 记 BASIC 给不出提示的次数
  （出货盘上应为 0，浏览器闸会读它）。
