# 智渡 Hidato · 数字链 · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

零依赖、无构建的 Hidato（亦作 Hidoku）纸面谜题网页。出货的每一盘都由穷举裁判证明过唯一解，

- 仓名：`z-biz-game-hidato-cos`　组别：E · 生成艺术与交互视觉
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node server.cjs
```

README 的快速开始：

```sh
node --check <每个 js/、tools/ 文件>     # 见 .github/workflows/ci.yml：js/ 与 tools/ 各一条 for 循环，外加 server.cjs
node tools/rule-test.mjs                # 规则词表与合法盘定义
node tools/pencil-test.mjs              # 铅笔每条推理对账真值
node tools/port-check.mjs               # 一次性端口对账，见下
SAMPLES=24 node tools/balance.mjs       # CI 抽样量；回填 TIERS 用 SAMPLES=60
bash tools/verify.sh                    # 浏览器闸（两种 URL 形态、八条腿）
node server.cjs                         # root 形态：仓库自己就是文档根，默认 5401
PREFIX=/z-biz-game-hidato-cos PORT=5501 node server.cjs   # Pages 的前缀形态
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 52 |
| 应用代码 | 4,113 行（JS 3,680 / CSS 311 / HTML 122） |
| 测试/工具文件 | 11 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 0 |
| 位图资产（不含 shots） | 13 个 / 462 KB |

## 目录

```
.github .gitignore LICENSE README.md assets css docs icons index.html js manifest.webmanifest package.json server.cjs sw.js tools
```

## 已知边界

README 没有单列“未实现/限制”小节；以 README 正文与仓内闸为准。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-hidato-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
