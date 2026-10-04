# 智渡 Hidato · 数字链

零依赖、无构建的 Hidato（亦作 Hidoku）纸面谜题网页。出货的每一盘都由穷举裁判证明过唯一解，
并且落在「不回溯的铅笔规则能从题面推到底」那一层上。

线上地址：<https://z-biz-game.github.io/z-biz-game-hidato-cos/>

## 玩法

在 R×C 的格子里把 1..N（N = R×C）各填一次，使**连续两个数所在的格子王式相邻** —— 共边或共角都算，
也就是切比雪夫距离 1。斜对可走是 Hidato 与只用横竖的 Numbrix 的唯一分界。
一部分数预印在格子里就是题面（clues / givens），整盘必须恰好有一种填满法。
按 Nikoli／Cross+A 的成例，最小数 1 与最大数 N **总是印在盘上**（本仓把这条当**成例策略**执行：
`droppableValues` 根本不把端点放进可删池，理由写在 `js/engine/rules.js` 的「端点不变量」一节 ——
它不是唯一性的前提，两端都不印仍然可能唯一）。

## 怎么玩这个页面

- **档位**：入门 5×5（25 格）／进阶 6×6（36 格）／挑战 7×7（49 格），出自 `js/engine/generate.js` 的 `TIERS`。
- **盘号（seed）**：输入框直接改，或者用 URL `?tier=6x6&seed=m1`。取值优先级是 URL 查询串 → 存档 → 默认
  （`js/main.js` 的 `DEFAULT_TIER = TIERS[0].key` = `5x5`、`DEFAULT_SEED` = `h0`）。
  seed **永不由日期派生**：同一串在 node 与浏览器里必须出同一张盘。
- **换一局**：把盘号串尾部的整数 +1（`h7`→`h8`；无尾数则补 1），所以每次点击都得到一个可原样重发的串，
  而不是「这一秒的第几张盘」。
- **落子**：点一格选中，再点右侧数字面板写入；键盘 `←↑→↓` 移选中格、`+`/`=` 加一、`-` 减一、
  退格键清空这格、`Tab` 到面板后 `Enter`/`空格` 落子。印着的格与 1、N 两个端点不能改也不能清。
- **提示**：只念页面自己再跑一遍的 `pencilSolve(G, given, BASIC_RULES)` 删剩的候选 —— 页面没有答案字段，
  所以提示不可能"作弊"。
- **判定**：把**你自己写的**编号交给 `js/engine/rules.js` 的 `verifyNumbering` 读回结论。
- **撤销 / 清空**：`undo()` 逐手回退（按落子成组），`clearAll()` 清掉玩家写入的部分，题面不动。
- **存档**：`localStorage['hidato.save.v1']`，字段按 `js/store.js` 的白名单 `SAVE_FIELDS`
  （`v` / `tier` / `seed` / `entries` / `steps` / `hints`）写。**真值绝不落盘**：`entries` 里印着的格恒为 `00`，
  题面由 tier+seed 现算回来；`ANSWERISH` 那份名单给浏览器闸当"扫到就红"的单点定义。
- 右侧「这一盘的来历」是引擎自己记的账（裁判读数 + 铅笔读数），`#reject` 段只在验收不过时摊开。

## 这一仓敢声称什么（也说清它不敢声称什么）

**唯一性是"出货那一层"的承诺。** 出货盘的题面由 `js/engine/counter.js` 的 `countSolutions`（传播引导的
穷举计数器，`limitSolutions=2`）证到恰好一个解，且 `provesUnique` 显式排除 `outcome==='stopped'`；
同一张题面另由两条不做传播的独立见证（`js/engine/witness.js` 的 `countWitnessA` / `countWitnessB`）
抽样对账。同时，出货盘必须让不回溯的命名规则铅笔（`js/engine/pencil.js` 的 `pencilSolve` + `BASIC_RULES`）
从题面推到底 —— 这两件事就是本仓的两条产品承诺，各自有红线（见 `tools/balance.mjs` 的 A–I）。

**「不可约」（irreducible）只适用于证书盘，不适用于出货盘。** `js/engine/generate.js` 的 `carveIrreducible`
按随机序试删 2..N−1，删掉后裁判仍**证明**唯一才真删；探针预算 `CARVE_PROBE`（nodeCap 40000 / msCap 60）
比出货裁判小一个数量级，探针被掐停（`stopped`）时那条线索**放回去**并记作 `keptByBudget`。
所以出货盘的题面一定**比不可约核心密**（密度梯 `ladderRungs` 往上补了线索），
本仓**不声称**任何出货盘"线索最少"或"每题面都不可约"。
本机 2026-09-29 一次 `SAMPLES=24 node tools/balance.mjs` 的读数：72 张出货盘全部 `RESULT balance ok=true checks=14 fails=0`，
红线 G3 打印的逐档 `keptByBudget` 是 1 / 10 / 39（要复跑这一读数就重跑那条命令）。
方向是安全的：因预算而留的线索只会让盘更密，绝不会少印。

**页面上的兜底：裁判被掐停 ⇒ 直接拒盘。** `js/ui/game.js` 的 `boardIsProven` 对 `proof.stopped` 返回 `false`，
未证明唯一或铅笔推不完的盘不作为题面发出去（`#reject` 摊开、棋盘收起）。这条存在是因为毫秒闸
理论上会让盘形随机器速度变，所以它由 `tools/balance.mjs` 红线 G2 断言"生产路径归因到 msCap 的击穿数 = 0"，
页侧证人就是 `window.hidato.state().proof.stoppedByMs` / `stoppedByNodes`。

## 怎么跑

```
node --check <每个 js/、tools/ 文件>     # 见 .github/workflows/ci.yml：js/ 与 tools/ 各一条 for 循环，外加 server.cjs
node tools/rule-test.mjs                # 规则词表与合法盘定义
node tools/pencil-test.mjs              # 铅笔每条推理对账真值
node tools/port-check.mjs               # 一次性端口对账，见下
SAMPLES=24 node tools/balance.mjs       # CI 抽样量；回填 TIERS 用 SAMPLES=60
bash tools/verify.sh                    # 浏览器闸（两种 URL 形态、八条腿）
node server.cjs                         # root 形态：仓库自己就是文档根，默认 5401
PREFIX=/z-biz-game-hidato-cos PORT=5501 node server.cjs   # Pages 的前缀形态
```

`tools/port-check.mjs` 的参照物是 2026-09-28 选型屏的输出 `_tmp-hidato-boards.tsv`，**按设计放在仓外**
（相对路径是 `../../`）。缺了它它自己就打印「port-check 跳过：参照物 …不在」并 **exit 3**
（本机 2026-09-29 把仓库复制到没有参照物的相对位置复跑实测），所以它只在本地跑、不进 CI ——
这不是引擎坏了，那一步本来就在本仓之外。有参照物时本机 2026-09-29 实测 `fingerprints 120/120`、`rc=0`。

浏览器闸 `tools/verify.sh` 自己起服务、自己找 Chrome，两种形态各跑八条腿
（boot-default / boot-url / crossengine / pointer / keyboard / resume / narrow / canary）。
Chrome 与 mktemp profile 是**按形态**各一份（同形态的八条腿共用这一份档），所以"谁写的档谁收尾"
是纪律：keyboard / resume / narrow / canary 各自在腿内 `gate.wipeSave()` 再起步。
本机 2026-09-29 实跑 `bash tools/verify.sh`：
root 与 prefix 各「8/8 legs reported · 497 checks · 0 failed」，退出码 0（Chrome 154.0.8037.57、node v26.8.1）。
阴性自证：`SABOTAGE=1`（改错期望）与 `PLANT_TRUTH=1`（当场种真值）都必须让那一跑**退出码非 0**，
具体组合列在 `tools/verify.sh` 的头部注释里。

已部署站点还有第三种形态：`BASE_URL=https://z-biz-game.github.io/z-biz-game-hidato-cos/ bash tools/verify.sh`
（只跑部署件、不起服务）。它**不在 CI 里跑** —— Pages 落地有传播延迟，接进 CI 只会得到一条与代码无关的
"有时红"的门。它由维护者在首次 deploy 之后手跑。

发布件里没有 Electron：`js/`、`tools/`、`server.cjs`、`package.json` 里没有任何 Electron 代码或依赖
（仓库里只剩 `.gitignore` 的一行 `.electron-cache/` 历史痕迹），页面是纯静态 ES module，跑起来只需要 node。
`git ls-files` 列出的就是全部出货与闸文件；CI 的 Pages 工件只取 `index.html` + `css/` + `js/`。

## CI 与 Pages

`.github/workflows/ci.yml`：`check` job（node 20，不装依赖）跑语法检查、`js/` 不 import `tools/` 的分层不变量、
入口接线证据、`rule-test` / `pencil-test` / `balance`（`SAMPLES=24`）三道 node 闸；
`browser` job（node 22 —— `tools/playtest.cjs` 是裸 CDP 驱动，依赖 node 全局 `WebSocket`，node 20 上第一条
attach 就抛）跑 `bash tools/verify.sh`。
`.github/workflows/pages.yml`：无构建 = 文件拷贝（`index.html` + `css/` + `js/`）→ `actions/configure-pages@v5`
→ `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`。

## 数字卫生

本页里的墙上读数与条数都是**某台机器某一次的观测值**，每条都附了复跑它的命令；
下一个接手的人请以复跑结果为准，不要把这些数字当契约 —— 契约在闸的退出码里。
盘不是 DOM 画布（本仓首页没有 canvas：`grep -c canvas index.html` 本机实测 0），别按 canvas 找它。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`27`）与这一次跑的断言条数（`45`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`27`、断言仍然 `45`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。

