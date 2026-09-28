#!/usr/bin/env bash
# 第五道闸（浏览器闸）· 智渡 Hidato：真 headless Chrome、真 DOM、真 localStorage、真指针
# —— 两种 URL 形态各跑一遍：
#
#   ① root    http://127.0.0.1:5401/                                   (server.cjs：仓库自己就是文档根)
#   ② prefix  http://127.0.0.1:5501/z-biz-game-hidato-cos/            (GitHub Pages 的形状，对应
#                                                                      https://z-biz-game.github.io/z-biz-game-hidato-cos/)
#
#   bash tools/verify.sh                       # 两种形态、全部腿
#   SHAPES=root bash tools/verify.sh           # 改东西时先只跑一种
#   LEGS="boot-url crossengine" bash tools/verify.sh
#   WEB_PORT=5401 CDP_PORT=9401 bash tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-hidato-cos/ bash tools/verify.sh
#                                              # 部署件：只跑这一种形态，本脚本不起任何服务（发布后手跑，不进 CI，见 docs/DESIGN.md）
#   SABOTAGE=1 LEGS="crossengine" SHAPES=root bash tools/verify.sh
#                                              # 闸的阴性自证：把 node 侧期望指纹改错一位，必须红**且 rc≠0**
#   SABOTAGE=1 LEGS="keyboard" SHAPES=root bash tools/verify.sh
#                                              # 键盘腿的阴性自证：期望轨迹被故意打断一格 ⇒ 那一键必红
#   SABOTAGE=1 LEGS="resume" SHAPES=root bash tools/verify.sh
#                                              # 续局腿的阴性自证：把"新文档"证人假装成**同文档片段跳转**
#   SABOTAGE=1 LEGS="narrow" SHAPES=root bash tools/verify.sh
#                                              # 窄屏腿的阴性自证：把期望的 dpr 换成 1（覆写实际给的是 2）
#                                              # ⇒ 覆写证人那条红：读数与请求的尺寸不符就是"没被覆写"
#   SABOTAGE=1 LEGS="canary" SHAPES=root bash tools/verify.sh
#                                              # canary 腿的阴性自证：拿掉 given-adjacency 那一张负样本
#                                              # ⇒ 那条"拒绝分支在浏览器里可达"必须红
#   PLANT_TRUTH=1 LEGS="resume" SHAPES=root bash tools/verify.sh
#                                              # 续局腿的阴性自证第二把：真值当场写进 localStorage ⇒ 落盘扫描必抓
#
# 为什么前缀形态必须单跑一遍而不是写进脚注：根形态是唯一一种能被本地服务器"蒙对"的形态。
# 页面级 `/js/...` 说明符在仓库=文档根时解得开，挂在 /<repo>/ 下就 404；而抛出来的 dynamic import
# 会把整段注入脚本一起带沉，于是部署站点静默地只跑了一小部分断言。
# tools/scenarios.js 里那个 mod() 特意按 document.baseURI 解析（import(new URL(rel, baseURI)))，
# 就是因为这个 —— 只有前缀那一跑能看见它到底解没解错。
#
# 端口是本仓的，不是家族的公共汽车：root web 5401 / 前缀 web 5501 / CDP 9401。
# 被占了就往后挪并打印"谁在听这一口"，绝不借别人已经绑上的 socket —— 借来的端口会发出**另一个应用**
# 的 index.html，而"页面加载成功了"分不清这件事，所以预检按字节比对磁盘上的模块。
#
# 每一条 URL 形态都用**自己新 mktemp 出来的 Chrome profile**：profile 里带着上一个形态的
# localStorage 与磁盘缓存，跨形态复用会把"首屏/续档"的读数变成别人的历史。
# 也不用 `mktemp -d -t <前缀>`：macOS 的 -t 把模板当成**前缀**并往后追加时间戳，两个形态拿到的是
# 不同的目录名却同样的语义，Linux 上 -t 干脆不是那个意思 —— 直接把模板写全。
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own. 本闸要的是真指针与真命中盒，假光栅会让读数说谎。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(basename "$HERE")                     # the Pages path segment, same as the repo slug
FEATURE=数字链                               # this app's own word: proof the bytes are ours
CDP_WANT=${CDP_PORT:-9401}
WEB_WANT=${WEB_PORT:-5401}
PREF_WANT=${PREFIX_PORT:-5501}
CHROME=${CHROME_BIN:-}
SABOTAGE=${SABOTAGE:-0}
PLANT_TRUTH=${PLANT_TRUTH:-0}        # 阴性自证第二把：把真值当场种进页面对象图，扫描必须抓到
# boot 默认腿（无查询串 ⇒ 走 js/main.js 的 DEFAULT_TIER/DEFAULT_SEED）与 URL 腿的档位盘号。
# URL 腿故意换一个**跟默认不同档**的盘：这样"首屏是 URL 决定的"才是正面证据而不是巧合。
BOOT_TIER=5x5; BOOT_SEED=h0
URL_TIER=6x6; URL_SEED=m1
PLAY_TIER=5x5; PLAY_SEED=h0                 # 场景 B 那张走完的 5×5（15 个非给定格）
RESUME_TIER=6x6; RESUME_SEED=m1             # 续局腿刻意换一档：它**不等于**默认档（js/main.js 的
#   DEFAULT_TIER=TIERS[0]=5x5 / DEFAULT_SEED=h0），而续局腿的导航 URL 不带查询串 ⇒
#   刷新后 boot.requested 落在 6x6/m1 上就只可能是**从存档读来的**，不可能是"默认值恰好撞上了"。
# 窄屏腿的视口与盘：390×844 + dpr 2 是"必须重排"的尺寸（CSS 那条 @media (max-width:520px) 命中、
#   board-wrap 从并排换成换行），盘故意挑**最宽的一档** 7x7（横向溢出风险最大）。
#   这两个数同时是断言的输入：verify.sh 把它们写进 expect 的 vwWant/vhWant/dprWant/mobileWant，
#   腿内读回 innerWidth/devicePixelRatio/clientWidth/innerHeight 逐条对账 ⇒ 覆写没生效就当场红。
NARROW_VIEWPORT=${NARROW_VIEWPORT:-390x844x2}
NARROW_TIER=7x7; NARROW_SEED=m0
# canary 腿的底座盘：node 侧从这张**出货盘**出发造负样本（掐停那一张用的就是它的题面 + 小 nodeCap）。
# 7x7 的出货盘裁判要 141+ 节点，nodeCap 掐到 40 必然停在 41 节点（<256 ⇒ ms 闸结构上到不了）。
# 不用 5x5/m0：那是 SABOTAGE_SEED 默认那一档（指纹会被故意改错），撞上来就让归因分不清了。
CANARY_TIER=7x7; CANARY_SEED=m0
# 每条形态的腿清单（本回合 8 条：2e 把 canary 与窄屏两条腿交齐了）。少交一回结果就是悄悄少跑。
LEGS_DONE=${LEGS:-"boot-default boot-url crossengine pointer keyboard resume narrow canary"}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
command -v python3 >/dev/null 2>&1 || { echo "需要 python3（RESULT 行的解析）" >&2; exit 2; }
{ command -v "$CHROME" >/dev/null 2>&1 || [ -x "$CHROME" ]; } || {
  echo "no Chrome found — 试过的路径：" >&2
  echo "  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome" >&2
  echo "  CHROME_BIN=/path/to/chrome bash tools/verify.sh" >&2
  exit 2; }

# 日志与 profile 落点：不写 /tmp 根 —— 这一台机器上有别的 agent 同时在跑 Chrome。
# 默认落在 $TMPDIR（macOS 是每用户私有的 /var/folders/...，Linux runner 上退到 /tmp）。
LOGDIR=${VERIFY_LOG_DIR:-"${TMPDIR:-/tmp}/hidato-verify"}
mkdir -p "$LOGDIR" || { echo "日志目录 $LOGDIR 建不起来" >&2; exit 2; }
rm -f "$LOGDIR"/*.tally "$LOGDIR"/*.extra.json 2>/dev/null

# ---- ports ---------------------------------------------------------------------------------------
occupied() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
squatters() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' '; }
first_free() {
  local base=$1 p
  for p in "$base" $((base + 1)) $((base + 100)) $((base + 200)); do
    if occupied "$p"; then
      echo "  端口 $p 已被别的进程听着（pid: $(squatters "$p")）——不借它的 socket，换下一个" >&2
    else
      echo "$p"; return 0
    fi
  done
  return 1
}

CUSTOM=0
[ -n "${BASE_URL:-}" ] && CUSTOM=1
if [ "$CUSTOM" = 0 ]; then
  CDP=$(first_free "$CDP_WANT") || { echo "no free devtools port near $CDP_WANT" >&2; exit 2; }
  WEB=$(first_free "$WEB_WANT") || { echo "no free http port near $WEB_WANT" >&2; exit 2; }
  PREF=$(first_free "$PREF_WANT") || { echo "no free http port near $PREF_WANT" >&2; exit 2; }
  echo "ports: CDP $CDP (want $CDP_WANT) · root web $WEB (want $WEB_WANT) · prefix web $PREF (want $PREF_WANT)"
  echo "  两种形态各用一个 HTTP 端口：origin 不同 ⇒ localStorage 各一套；Chrome/profile 按形态各一份，该形态的八条腿共用"
else
  CDP=${CDP_PORT:-$CDP_WANT}
  echo "BASE_URL given → 只跑部署件这一种形态，本脚本不起任何服务（CDP $CDP）"
fi
echo "logs: $LOGDIR"
[ "$PLANT_TRUTH" = 1 ] && echo "PLANT_TRUTH=1 → boot 场景会把 node 侧真值挂到 hidato.gate.__plantedTruth 上再扫（扫不到就该红）"
[ "$SABOTAGE" = 1 ] && echo "SABOTAGE=1 → node 侧只把 ${SABOTAGE_SEED:-5x5/m0} 那一盘的期望指纹改错一位：这一跑**必须**在那一条上红，绿了就是闸没咬住"
echo "loadavg（跑之前的读数，本机可能同时坐着别的 agent）：$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg)"

FAILED=0
WANT_N=$(echo "$LEGS_DONE" | wc -w | tr -d ' ')

# ---- machine-readable RESULT line ----------------------------------------------------------------
# playtest.cjs 把 RESULT 打在 stdout 最后一行、console 噪音留在 stderr。这里不数行数就不叫跑过：
# 一条断言都没发生的场景（页面启动失败、import 404、场景被改名）会以"0 failed"的样子绿过去，
# 所以空 rows / 解析不出来 / 拿不到 RESULT 一律 exit 1，并把条数写进 tally 让上面那层核对
# "该报 4 段是不是只报了 3 段"。extra 落到 .extra.json：跨引擎那一腿把 18 组读数的摘要写在这里。
PARSE=$(cat <<'PARSER'
import sys, json
shape, scn, tally, extra_path = sys.argv[1:5]
raw = sys.stdin.read().strip()
if raw.startswith('RESULT '):
    raw = raw[len('RESULT '):]
if not raw:
    print('  NO RESULT —— playtest.cjs 什么都没回（见同目录的 .console.log）'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
rows = d.get('rows')
if rows is None:
    print('  NO RESULT FIELD —— 回的东西不是闸的口径:', str(d)[:300]); sys.exit(1)
if not rows:
    print('  NO CHECKS RUN —— 一条都不断言的场景没有资格是绿的'); sys.exit(1)
for r in rows:
    if not r['pass']:
        print('  FAIL %-58s %s' % (r['test'], r['detail']))
fail = int(d.get('fail', 0))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
# 下划线前缀的键 = **墙上时钟读数**（续局腿的 performance.timeOrigin 前后两个值就是这类）。
# 它们必须落进 .extra.json 供复验读，但绝不能进 stdout：三连跑的判据是"两次输出逐字节 diff 为空"，
# 而 timeOrigin 每一次刷新都换一个数。判据一条没放宽（这些值全都以"变了/没变"的断言形态被判定），
# 只是把机器相关的读数从可 diff 的那条通道里挪出去 —— 改的是措辞，不是阈值。
stable = {k: v for k, v in extra.items() if not k.startswith('_')}
with open(tally, 'w') as f:
    f.write('%d %d\n' % (len(rows), fail))
with open(extra_path, 'w') as f:
    json.dump(extra, f)
print('  %d checks, %d failed  %s' % (len(rows), fail, json.dumps(stable, ensure_ascii=False)[:400]))
sys.exit(1 if fail else 0)
PARSER
)

# ---- pre-flight: 即将被检的那几字节就是本仓 ---------------------------------------------------------
# 端口上坐着*别的*东西是这个闸存在的意义；"页面加载了"不够 —— SPA fallback、目录列表、孤儿 checkout
# 都能让场景跑起来，只是对着更少的文件跑。所以每个模块路径都要求 200 **且**字节数与磁盘一致。
PREFLIGHT_RELS="index.html css/game.css js/main.js js/store.js js/ui/game.js js/render/board.js js/engine/rules.js js/engine/generate.js js/engine/pencil.js js/engine/counter.js js/engine/rng.js"
preflight() {
  local base=$1 rel want got f served
  served=$(curl -fsS -m 8 "$base" 2>/dev/null) || { echo "  首页取不到：$base" >&2; return 1; }
  case "$served" in *js/main.js*) ;; *) echo "  $base 上发的不是本仓的首页（正文里找不到 js/main.js）" >&2; return 1 ;; esac
  case "$served" in *"$FEATURE"*) ;; *) echo "  $base 在发别的应用：首页正文里找不到「$FEATURE」" >&2; return 1 ;; esac
  for rel in $PREFLIGHT_RELS; do
    want=$(wc -c < "$HERE/$rel" | tr -d ' ')
    [ -n "$want" ] || { echo "  $rel 在磁盘上读不到，闸没有可对的基准" >&2; return 1; }
    f="$LOGDIR/preflight-$(echo "$rel" | tr '/' '_')"
    got=$(curl -sS -m 8 -o "$f" -w '%{http_code} %{size_download}' "$base$rel" 2>/dev/null) || {
      echo "  $rel 取不回来：$base$rel" >&2; return 1; }
    case "$got" in "200 $want") ;; *)
      echo "  $rel 不对味：$base$rel 回 $got，磁盘上的这份是 200 $want 字节" >&2
      echo "  前两行到手内容：$(head -c 160 "$f" | tr '\n' ' ')" >&2
      return 1 ;; esac
  done
  echo "  预检：首页含「$FEATURE」与 js/main.js · $(echo $PREFLIGHT_RELS | wc -w | tr -d ' ') 条真实模块路径按字节对上磁盘"
  return 0
}

start_chrome() {                  # 每一条**形态**一个新 profile、一个新 Chrome（tag 就是形态名）
  # 为什么按形态而不是按腿：这一形态的 localStorage 不许是上一形态写的，而 Chrome 起停是这条闸
  # 最贵的一段（每条腿一次起停 ≈ 多烧 8 次 Chrome 起停）。代价是同形态八条腿共用一份档，于是
  # "谁写的档谁收尾"成了纪律：keyboard / resume / narrow / canary 每条腿在腿内自己
  # 先 gate.wipeSave()；boot-default 那条"新 profile 上无档可续"靠的是下面 run_shape 里那句
  # 「先把 tab 停在 404 上、应用页一次都没跑过」+ 它排在清单最前。把清单换个顺序真跑过
  # （LEGS="resume boot-default"）：boot-default 会红一片并 rc=1，是响的，不是假绿。
  local tag=$1
  UDD=$(mktemp -d "${TMPDIR:-/tmp}/hidato.${tag}.XXXXXXXX") || { echo "profile 建不起来" >&2; return 1; }
  "$CHROME" --headless=new --remote-debugging-port=$CDP --user-data-dir="$UDD" \
    --window-size=1280,1024 --no-first-run --no-default-browser-check about:blank \
    >"$LOGDIR/chrome-$tag.log" 2>&1 &
  CPID=$!
  for i in $(seq 1 120); do
    curl -fsS -m 1 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "devtools never bound on :$CDP (see $LOGDIR/chrome-$tag.log)" >&2
  return 3
}
stop_chrome() {
  [ -n "${CPID:-}" ] && { kill -9 "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null; }
  [ -n "${UDD:-}" ] && rm -rf "$UDD"
  CPID=""; UDD=""
  return 0
}

# run_leg <shape> <leg> —— 腿名到"场景 / mode / 导航 URL / node 期望"的那张表在这里，只有一处。
run_leg() {
  local shape=$1 leg=$2 base=$3 s expect='' nav='' mode=scenario
  local vp=$VIEWPORT mob=0             # 默认走这一形态的视口；个别腿自己换（见 keyboard / narrow）
  s=$leg                       # 报告用的腿名；场景名在下面这张表里
  case "$leg" in
    boot-default)
      s=boot
      nav="$base"
      expect=$(node tools/playtest.cjs witness "$BOOT_TIER" "$BOOT_SEED") || { echo "  node 证人起不来（$BOOT_TIER/$BOOT_SEED）" >&2; RUNBAD=1; return; }
      [ "$PLANT_TRUTH" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["plant"]=1;print(json.dumps(d))')
      ;;
    boot-url)
      s=boot
      nav="${base}?tier=${URL_TIER}&seed=${URL_SEED}"
      expect=$(node tools/playtest.cjs witness "$URL_TIER" "$URL_SEED") || { echo "  node 证人起不来（$URL_TIER/$URL_SEED）" >&2; RUNBAD=1; return; }
      [ "$PLANT_TRUTH" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["plant"]=1;print(json.dumps(d))')
      ;;
    crossengine)
      nav="$base"
      ;;
    pointer)
      s=pointer
      mode=interact
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      ;;
    keyboard)
      # 真键盘腿：CDP Input.dispatchKeyEvent 派进来的键，页面一个 hidato.* 动词都不许调。
      # 视口故意压到 1280×720 —— 这一页在 1024 高时不溢出，"方向键没滚页"那条断言就变成白断言；
      # 溢出之后 scrollY 必须由 preventDefault 才守得住 0（键盘腿里另有一条证人确认它真的可滚）。
      s=keyboard
      mode=interact
      vp=${KB_VIEWPORT:-1280x720}
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      # 阴性自证：把**期望轨迹**故意打断一格（真键盘不会走两步 ⇒ 那一格必红）
      [ "$SABOTAGE" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["kbBreak"]=1;print(json.dumps(d))')
      ;;
    resume)
      # 续局腿：故意**不带查询串** —— 盘只能来自默认或存档，刷新后 boot.requested 落在存档那一档上
      # 才是"续的是档"的正面证据。RESUME_TIER/RESUME_SEED 与默认档（5x5/h0）不同，见下面两条注释。
      s=resume
      mode=interact
      nav="$base"
      expect=$(node tools/playtest.cjs witness "$RESUME_TIER" "$RESUME_SEED") || { echo "  node 证人起不来（$RESUME_TIER/$RESUME_SEED）" >&2; RUNBAD=1; return; }
      # 阴性自证第一把：把"新文档"这个证人**假装成同文档片段跳转**（哨兵/timeOrigin/href 三条当场红）
      [ "$SABOTAGE" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["fakeReload"]=1;print(json.dumps(d))')
      # 阴性自证第二把：把 node 侧真值当场写进 localStorage，刷新后那两条落盘卫生扫描必须抓到
      [ "$PLANT_TRUTH" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["plant"]=1;print(json.dumps(d))')
      ;;
    narrow)
      # 窄屏/移动端腿：视口与 dpr 的覆写发生在**这条腿自己那一次 playtest 调用**里（attach 之后、
      # 首次导航之前、同一个 CDP session）。绝不另起一个进程设覆写就退出 —— 兄弟仓那版"移动腿"就是这么
      # 写的，于是跑断言的那个进程从没被覆写，在 vw 1280 / dpr 1 下把桌面那套断言又跑一遍，
      # 报出与桌面腿**相同的条数**（这一族最贵的假绿）。判据：读回的 vw/dpr 必须与请求的对上，
      # 且这一腿的断言是窄屏形状（横向溢出 / 逐格命中盒 / 重排证人 / 44px 指尖目标），条数不可能与桌面腿相同。
      s=narrow
      vp=$NARROW_VIEWPORT
      mob=1
      nav="${base}?tier=${NARROW_TIER}&seed=${NARROW_SEED}"
      expect=$(node tools/playtest.cjs witness "$NARROW_TIER" "$NARROW_SEED") || { echo "  node 证人起不来（$NARROW_TIER/$NARROW_SEED）" >&2; RUNBAD=1; return; }
      # 把"请求了什么视口"写进期望值：页内读回的 innerWidth / devicePixelRatio / clientWidth /
      # innerHeight 逐条与它对账 ⇒ 覆写没生效（读数 = Chrome 窗口那一对）当场红。
      expect=$(printf '%s' "$expect" | python3 -c '
import sys, json
d = json.load(sys.stdin)
p = sys.argv[1].split("x")
d["vwWant"] = int(p[0]); d["vhWant"] = int(p[1])
d["dprWant"] = int(p[2]) if len(p) > 2 else 1
d["mobileWant"] = True
print(json.dumps(d))' "$vp") || { echo "  窄屏腿的视口三元组拼不进 expect（$vp）" >&2; RUNBAD=1; return; }
      # 阴性自证：把**期望的 dpr** 换成 1（覆写实际给的是 2）⇒ 覆写证人红 + 那条"请求的不是桌面那一队"红。
      [ "$SABOTAGE" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["dprWant"]=1;print(json.dumps(d))')
      ;;
    canary)
      # 拒盘 canary：这一腿不验"页面能出货"，验的是**拒绝分支在浏览器里到得了**
      # （铅笔推不完 / nodeCap 掐停 / count!==1 / given-adjacency / 端点没印全）。
      # 题面与期望读数由 node 侧证人（playtest.cjs canary）算，页内不现生成；
      # 掐停只许 nodeCap（<256 ⇒ counter.js 每 256 个节点才查一次的 ms 闸结构上到不了）——
      # 用 msCap 造负样本会让盘形跟着机器速度变，那是本组织的红线，一条都不许碰。
      s=canary
      nav="$base"
      expect=$(node tools/playtest.cjs canary "$CANARY_TIER" "$CANARY_SEED") || { echo "  canary 的 node 证人交不出五张负样本（$CANARY_TIER/$CANARY_SEED）" >&2; RUNBAD=1; return; }
      # 阴性自证：拿掉 given-adjacency 那一张负样本 ⇒ 那条"分支可达"必须红（这一腿最值钱的就是让人
      # 看见拒绝分支没被走到，所以它必须能红）。
      [ "$SABOTAGE" = 1 ] && expect=$(printf '%s' "$expect" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["canaryDrop"]="adjacency";print(json.dumps(d))')
      ;;
    *) echo "  不认识这条腿：$leg" >&2; RUNBAD=1; return ;;
  esac
  local tally extra clog n m
  tally="$LOGDIR/$shape-$s.tally"; extra="$LOGDIR/$shape-$s.extra.json"; clog="$LOGDIR/$shape-$s.console.log"
  rm -f "$tally" "$extra"
  echo "=== [$shape] $s (mode ${mode:-scenario}, viewport $vp, mobile $mob, nav $nav) ==="
  VIEWPORT=$vp EMULATE_MOBILE=$mob NAV_URL=$nav node tools/playtest.cjs "$mode" "$s" "$expect" 2>"$clog" | tail -1 \
    | python3 -c "$PARSE" "$shape" "$s" "$tally" "$extra" || RUNBAD=1
  if [ -s "$tally" ]; then
    read -r n m < "$tally"
    REPORTED=$((REPORTED + 1)); CHECKS=$((CHECKS + n)); FAILS=$((FAILS + m))
  else
    RUNBAD=1
    echo "  没有 tally：$s 这一跑连条数都没交出来，不能算跑过"
  fi
  if [ -s "$clog" ]; then
    echo "  --- console (tail 8) ---"
    sed 's/^/  /' "$clog" | tail -8
  fi
  return 0
}

# ---- one shape -----------------------------------------------------------------------------------
run_shape() {
  local shape=$1 base s
  local t0 t1
  t0=$SECONDS
  REPORTED=0; CHECKS=0; FAILS=0; RUNBAD=0
  SPID=0; PPID2=0
  VIEWPORT=${VIEWPORT_DEFAULT:-1280x1024}
  if [ "$CUSTOM" = 1 ]; then
    base=$BASE_URL
  elif [ "$shape" = root ]; then
    base="http://127.0.0.1:$WEB/"
    PORT=$WEB node "$HERE/server.cjs" >"$LOGDIR/$shape-server.log" 2>&1 &
    SPID=$!
  else
    # Pages 形状：仓库挂在**一个路径段**下。用的就是产品自己那份 server.cjs（PREFIX=/z-biz-game-hidato-cos），
    # 不另起一个 python 服务器 —— 生产怎么服务，闸就怎么服务，裸 / 404 这类形状差异才有意义。
    base="http://127.0.0.1:$PREF/$REPO/"
    PREFIX="/$REPO" PORT=$PREF node "$HERE/server.cjs" >"$LOGDIR/$shape-server.log" 2>&1 &
    PPID2=$!
  fi
  BASE=$base
  export CDP_PORT=$CDP
  export BASE_URL=$BASE
  # 每一条形态一个新 Chrome profile：这一形态的 localStorage 不许是上一形态写的
  start_chrome "$shape" || return 5
  if [ "$CUSTOM" = 0 ]; then
    for i in $(seq 1 40); do curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  echo
  echo "################ shape=$shape  base=$BASE  (CDP :$CDP, profile $UDD)"
  preflight "$BASE" || return 2

  # 先在一个**本 origin 的 404 路径**上把 tab 拉起来：origin 对得上 ⇒ 后面的场景腿复用这个 tab，
  # 而应用页一次都没跑过 ⇒ hidato.save.v1 还是空的，boot-default 那一段"新 profile 上无档可续"才是真的。
  # （直接 open 首页就会把当前盘写进存档，那段断言就变成在验自己刚写的档。）
  VIEWPORT=$VIEWPORT node tools/playtest.cjs open "${BASE}hidato-probe-404" | head -2
  echo "boot 读数由 boot 场景交回（version / timeOrigin / 出货盘指纹都在它的 extra 里）"

  for s in $LEGS_DONE; do
    run_leg "$shape" "$s" "$BASE"
  done

  t1=$((SECONDS - t0))
  echo "---- shape=$shape 汇总: $REPORTED/$WANT_N legs reported · $CHECKS checks · $FAILS failed ----"
  # 墙上时间单独一行：它是**这台机器的读数**，不是闸的读数。混在汇总那一行里，
  # "同一条命令连跑两次逐字节 diff 为空"就永远做不到（3s/4s 抖一下就差一个字节）。
  # 判据、条数、阈值一个没动 —— 挪走的只是时钟，跟 extra 里下划线前缀那几个键同一处理。
  echo "     本形态墙上耗时 ${t1}s（机器相关读数，不参与逐字节对账）"
  if [ "$REPORTED" != "$WANT_N" ]; then
    echo "  少了一段腿交回结果：清单要 $WANT_N 段，只收到 $REPORTED 段 —— 悄悄少跑不能算绿" >&2
    RUNBAD=1
  fi
  [ "$RUNBAD" = 0 ] || FAILED=1
  stop_chrome
  [ "$SPID" != 0 ] && { kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; }
  [ "$PPID2" != 0 ] && { kill $PPID2 2>/dev/null; wait $PPID2 2>/dev/null; }
  SPID=0; PPID2=0
  return $RUNBAD
}

cleanup() {
  # 只杀自己起的那几个 pid；别的 agent 的 Chrome / 服务器一律不动。
  # 看门狗也要在这里杀掉：脚本中途 die 时若留着它，它会在 900s 后拿一份早失效的
  # pid 表再跑一次 cleanup——那些 pid 号可能已被系统回收给别人。
  [ -n "${WD:-}" ] && kill "$WD" 2>/dev/null
  [ "${SPID:-0}" != 0 ] && kill $SPID 2>/dev/null
  [ "${PPID2:-0}" != 0 ] && kill $PPID2 2>/dev/null
  stop_chrome
  return 0
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
# WD= inside the subshell: cleanup kills the watchdog, and a watchdog that kills itself would
# abort its own TERM handler halfway and leave Chrome/servers behind.
# 900s 是四条腿那一版的预算。清单现在是八条腿 × 两形态：键盘腿一条要 4 个回合（keysTotal 42 次真派发）、
# 续局腿要两次整页启动 + 一次 Page.reload + 6x6 现生成两遍 ⇒ 每形态 8 次 playtest 起停（Chrome 只有形态那一次）。
# 按 900s 跑会在尾巴上被判"到点"，那是**看门狗替闸作了决定**，不是断言红 —— 所以把默认提到 1800。
( sleep ${WD_TIMEOUT:-1800}; echo "watchdog 到点：闸还没跑完" >&2; WD=; cleanup; exit 4 ) </dev/null >/dev/null 2>&1 &
WD=$!

cd "$HERE"
SHAPE_LIST="root prefix"
[ "$CUSTOM" = 1 ] && SHAPE_LIST=custom
RAN=""
for shape in ${SHAPES:-$SHAPE_LIST}; do
  RAN="$RAN $shape"
  run_shape "$shape" || FAILED=1
done

kill $WD 2>/dev/null
# wait for it: otherwise bash's job control prints "Terminated: 15  ( sleep … )" on stderr
# right after, and a green run looks like it broke something.
wait $WD 2>/dev/null
WD=   # reaped: don't let the EXIT trap kill a pid number that may already belong to someone else
echo "loadavg（这一跑结束时）：$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg)"
echo "chrome: $("$CHROME" --version 2>/dev/null) · node: $(node --version)"
# 只报这一跑真的跑过的形态：SHAPES=root / BASE_URL= 那种单形态跑，旧文案照样打印"两种 URL 形态"。
# 阴性自证也走同一条出口：故意改错期望时这一跑的 **rc 必须非 0**。
# 这里以前是 `exit 0`，意思是"红由人眼看 FAIL 行"—— 那正好把唯一一条能被 CI 读的信号掐掉了：
# 一次带 2 条 FAIL 的跑会返回 0，于是"闸会红"这件事从来没被机器证明过。
[ "$SABOTAGE" = 1 ] && echo "=== 阴性自证这一跑：期望被故意改错，上面必须有 FAIL 且**退出码非 0** ==="
[ "$PLANT_TRUTH" = 1 ] && echo "=== 阴性自证这一跑：真值被当场种进对象图，上面必须有 FAIL 且**退出码非 0** ==="
[ $FAILED -eq 0 ] && echo "=== ALL GREEN（这一跑实际覆盖的 URL 形态：${RAN# }）===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
