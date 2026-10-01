#!/usr/bin/env python3
"""智渡 Hidato 的美术资产生成器（纯 python3 标准库，零依赖，逐字节确定性）。

为什么仓内自带生成器，而不是拿一张下载图或一张手写 SVG：
  1. 本仓的视觉母题**就是玩法本身**。图标/社交卡/纹理里那条折线，是按 js/engine/rules.js
     的同一条语义（8 邻接国王步、不重复、走完 25 格、端点是 1 与 25）走出来的哈密顿链，
     不是随便画的装饰线。母题能用代码写出来 ⇒ 改配色或换档位能整批重刷 12 张位图。
  2. 配色一个都不凭空编：全部抄自 css/game.css 的实测十六进制（--ink / --paper / --accent
     / --line / --good / --bad）。改了 CSS 那几个数就要改这里，两边说的是同一句话。
  3. 判据要的是**真位图**：sellability 的 `图标` 数的是"边长 ≥180 的真 PNG 张数"，
     手写 SVG 冒充 PNG、0 字节占位都不算。本脚本产出 RGBA8 PNG（IHDR/IDAT/IEND 自己拼）。

确定性口径与仓库的 seed 口径同一条：随机只来自写死常数的 LCG，不读时钟、不读环境、
不读 PYTHONHASHSEED ⇒ 任何机器上重跑都得到同一个 sha256。

跑法:
  python3 assets/gen/gen_art.py          # 生成全部资产，逐张打印 尺寸/字节/sha256 前 12 位
"""
import hashlib
import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# ── 配色：与 css/game.css 一一对应的实测值 ────────────────────────────────────────
INK = (0x1B, 0x1A, 0x18)          # --ink
INK_LIT = (0x2A, 0x26, 0x21)      # --ink 受光上限（只用于竖向渐变）
PAPER = (0xFB, 0xF8, 0xF2)        # --paper
PAPER_ALT = (0xF2, 0xED, 0xE4)    # --paper-alt
LINE = (0xCF, 0xC7, 0xB8)         # --line
BRASS = (0x8A, 0x5A, 0x2B)        # --accent：链子的本体色
BRASS_LIT = (0xC9, 0x8B, 0x3F)    # --accent 提亮：描边高光
GOOD = (0x2F, 0x6B, 0x40)         # --good：端点 1
BAD = (0xB2, 0x3A, 0x30)          # --bad：端点 25

GRID_N = 5                        # 图标底衬 = TIERS 的第一档 5×5


class Lcg:
    """NR 常数 LCG：本脚本唯一的随机源（路径取样用）。"""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s >> 8


def png_bytes(w, h, rows):
    """rows: 每行 bytes，长度 4*w（RGBA8）。filter 0 + zlib level 9。"""
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


class Buf:
    """RGBA 帧缓冲。批量路子（切片赋值）优先，逐像素只留给抗锯齿带。"""

    __slots__ = ('w', 'h', 'rows')

    def __init__(self, w, h, fill=INK):
        self.w, self.h = w, h
        solid = bytes(list(fill[:3]) + [255]) * w
        self.rows = [bytearray(solid) for _ in range(h)]

    def solid_span(self, y, x0, x1, color):
        """整段不透明上色（C 速度）：本仓所有"内部"都走这条路。"""
        if not (0 <= y < self.h):
            return
        x0 = max(0, x0)
        x1 = min(self.w, x1)
        if x1 <= x0:
            return
        self.rows[y][x0 * 4:x1 * 4] = bytes(color[:3] + (255,)) * (x1 - x0)

    def px(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.rows[y][x * 4:x * 4 + 4] = bytes(color[:3] + (255,))

    def put_px(self, x, y, color, a):
        """写一个带独立 alpha 的像素（半透明位图专用：图集帧、光晕）。"""
        if 0 <= x < self.w and 0 <= y < self.h:
            self.rows[y][x * 4:x * 4 + 4] = bytes(color[:3] + (min(255, int(a * 255 + 0.5)),))

    def blend(self, x, y, color, a):
        """alpha 合成（不透明底色 ⇒ 合完仍不透明）。AA 带专用。"""
        if not (a > 0) or not (0 <= x < self.w and 0 <= y < self.h):
            return
        r = self.rows[y]
        o = x * 4
        if a >= 0.999:
            r[o:o + 3] = bytes(color[:3])
            r[o + 3] = 255
            return
        ia = 1.0 - a
        r[o] = int(color[0] * a + r[o] * ia + 0.5)
        r[o + 1] = int(color[1] * a + r[o + 1] * ia + 0.5)
        r[o + 2] = int(color[2] * a + r[o + 2] * ia + 0.5)
        r[o + 3] = 255

    def blend_span(self, y, x0, x1, color, a):
        for x in range(x0, x1):
            self.blend(x, y, color, a)

    def rect(self, x0, y0, x1, y1, color):
        for y in range(y0, y1):
            self.solid_span(y, x0, x1, color)

    def vgrad(self, top, bottom):
        span = max(1, self.h - 1)
        for y in range(self.h):
            t = y / span
            c = tuple(int(top[i] + (bottom[i] - top[i]) * t + 0.5) for i in range(3))
            self.solid_span(y, 0, self.w, c)

    def rgba_rows(self):
        return [bytes(r) for r in self.rows]


# ── 5×7 位图字体（自点阵：A-Z / 0-9 / · . - : 空格；一行 5 列，7 行用 / 分隔）──────
GLYPH_W, GLYPH_H = 5, 7
FONT = {
    'A': '.###./#...#/#...#/#####/#...#/#...#/#...#',
    'B': '####./#...#/#...#/####./#...#/#...#/####.',
    'C': '.###./#...#/#..../#..../#...#/#...#/.###.',
    'D': '####./#...#/#...#/#...#/#...#/#...#/####.',
    'E': '#####/#..../#..../####./#..../#..../#####',
    'F': '#####/#..../#..../####./#..../#..../#....',
    'G': '.###./#...#/#..../#.###/#...#/#...#/.###.',
    'H': '#...#/#...#/#...#/#####/#...#/#...#/#...#',
    'I': '#####/..#../..#../..#../..#../..#../#####',
    'J': '#####/....#/....#/....#/#...#/#...#/.###.',
    'K': '#...#/#..#./#.#../###../#.#../#..#./#...#',
    'L': '#..../#..../#..../#..../#..../#..../#####',
    'M': '#...#/##.##/#.#.#/#...#/#...#/#...#/#...#',
    'N': '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
    'O': '.###./#...#/#...#/#...#/#...#/#...#/.###.',
    'P': '####./#...#/#...#/####./#..../#..../#....',
    'Q': '.###./#...#/#...#/#...#/#.#.#/#..#./.###.',
    'R': '####./#...#/#...#/####./#.#../#..#./#...#',
    'S': '.###./#...#/#..../.###./....#/#...#/.###.',
    'T': '#####/..#../..#../..#../..#../..#../..#..',
    'U': '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
    'V': '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
    'W': '#...#/#...#/#.#.#/#.#.#/#.#.#/##.##/#...#',
    'X': '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
    'Y': '#...#/#...#/.#.#./..#../..#../..#../..#..',
    'Z': '#####/....#/...#./..#../.#.../#..../#####',
    '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
    '1': '..#../.##../..#../..#../..#../..#../#####',
    '2': '.###./#...#/....#/..##./.#.../#..../#####',
    '3': '####./....#/....#/.###./....#/....#/####.',
    '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
    '5': '#####/#..../####./....#/....#/#...#/.###.',
    '6': '.###./#...#/#..../####./#...#/#...#/.###.',
    '7': '#####/....#/...#./..#../.#.../.#.../.#...',
    '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
    '9': '.###./#...#/#...#/.####/....#/#...#/.###.',
    '·': '...../...../...../..#../...../...../.....',
    '.': '...../...../...../...../...../...../..#..',
    '-': '...../...../...../#####/...../...../.....',
    ':': '...../..#../...../...../...../..#../.....',
}
# 形状自检：点错一个字符就启动即抛，不让它变成"图上悄悄缺笔画"。
for _k, _g in FONT.items():
    _rows = _g.split('/')
    assert len(_rows) == GLYPH_H and all(len(_r) == GLYPH_W for _r in _rows), '字形不是 5×7: %r' % _k
    assert set(''.join(_rows)) <= {'.', '#'}, '字形含非法字符: %r' % _k
GLYPHS = {k: v.split('/') for k, v in FONT.items()}



def text_width(text, scale, tracking=1):
    return len(text) * (GLYPH_W + tracking) * scale - tracking * scale if text else 0


def draw_text(buf, text, x0, y0, scale, color, tracking=1):
    """点阵字：一个字一个 5×7，实心方块按 scale 放大 ⇒ 任何尺寸下都是硬边、可读。"""
    x = x0
    for ch in text.upper():
        if ch == ' ':
            x += (GLYPH_W + tracking) * scale
            continue
        glyph = GLYPHS.get(ch)
        if glyph:
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == '#':
                        buf.rect(x + gx * scale, y0 + gy * scale,
                                 x + (gx + 1) * scale, y0 + (gy + 1) * scale, color)
        x += (GLYPH_W + tracking) * scale
    return x


# ── 母题：一条走完 25 格的国王步链（与 rules.isAdjacent 同语义）───────────────────
def king_path(n=GRID_N * GRID_N, seed=0x5EED):
    """一条走完 n 格的国王步链（哈密顿路径）。

    为什么不裸回溯：实测在 5×5 国王步图上"随机邻居序 + 回溯"要跑 ~180 秒才凑出 25 格
    （绝大多数半路都会走进死角，搜索树炸开），而它是 import 期跑的 ⇒ 生成器 3 分钟里几乎全是它。
    改成 Warnsdorff 启发式：每步优先走"未访问邻居数最少"的那格（先把容易堵死的角落吃掉），
    同分之间用写死种子的 LCG 打散 ⇒ 形状确定、不是直挺挺的对角线，且毫秒级出结果。
    回溯仍然保留：启发式失手时兜底，走不出来就抛（母题不能是一条断链）。
    """
    rnd = Lcg(seed)
    coords = [(r, c) for r in range(GRID_N) for c in range(GRID_N)]

    def nbrs(cell):
        r, c = cell
        out = [(r + dr, c + dc)
               for dr in (-1, 0, 1) for dc in (-1, 0, 1)
               if (dr or dc) and 0 <= r + dr < GRID_N and 0 <= c + dc < GRID_N]
        for i in range(len(out) - 1, 0, -1):     # Fisher-Yates：LCG 是唯一随机源
            j = rnd.next() % (i + 1)
            out[i], out[j] = out[j], out[i]
        return out

    NEIGH = {cell: nbrs(cell) for cell in coords}
    start = coords[rnd.next() % len(coords)]
    used = {start}
    path = [start]

    def extend():
        if len(path) == n:
            return True
        cur = path[-1]
        # 按"走进去之后还剩几个未访问邻居"升序：先堵角，再留活口
        cand = [(sum(1 for x in NEIGH[q] if x not in used and x != cur), q)
                for q in NEIGH[cur] if q not in used]
        cand.sort(key=lambda t: t[0])
        for _, nxt in cand:
            used.add(nxt)
            path.append(nxt)
            if extend():
                return True
            path.pop()
            used.discard(nxt)
        return False

    if not extend():
        raise RuntimeError('走不出 %d 格的国王步链 —— 母题不能是断链' % n)
    return path


PATH = king_path()


def path_points(size, pad):
    """PATH 的像素中心序列（画面 size×size，四周留白 pad）。"""
    step = (size - 2 * pad) / GRID_N
    return [(pad + step * (c + 0.5), pad + step * (r + 0.5)) for (r, c) in PATH], step


def disc(buf, cx, cy, rad, color, aa=1.6):
    """圆：内部整行铺色，边缘 aa 像素逐点合成。"""
    y0 = max(0, int(cy - rad - aa))
    y1 = min(buf.h, int(cy + rad + aa) + 1)
    for y in range(y0, y1):
        dy = y + 0.5 - cy
        k = rad * rad - dy * dy
        if k <= 0:
            continue
        half = math.sqrt(k)
        xl, xr = cx - half, cx + half
        buf.solid_span(y, int(math.ceil(xl + aa)), int(math.floor(xr - aa)) + 1, color)
        for x in range(max(0, int(math.floor(xl - aa))), min(buf.w, int(math.ceil(xr + aa)) + 1)):
            d = math.hypot(x + 0.5 - cx, dy)
            a = (rad + aa - d) / (2.0 * aa)
            if 0 < a < 0.999:
                buf.blend(x, y, color, a)


def capsule(buf, ax, ay, bx, by, half, color, aa=1.6):
    """线段 + 两端圆帽（运动场形）。逐行解析求交区间 ⇒ 内部整行铺色，只在边缘花逐点。

    行内的距离判据都在**以 A 为原点的相对坐标** (px,py) 里解，解完统一 + ax 回到绝对像素；
    这一步以前漏了，于是整条链被推到画布左缘外（母图实测只有左边一条竖带）。
    """
    vx, vy = bx - ax, by - ay
    length = math.hypot(vx, vy)
    if length <= 1e-9:
        disc(buf, ax, ay, half, color, aa)
        return
    ux, uy = vx / length, vy / length
    nx, ny = -uy, ux
    BIG = 1e9
    y0 = int(min(ay, by) - half - aa) - 1
    y1 = int(max(ay, by) + half + aa) + 2
    for y in range(max(0, y0), min(buf.h, y1)):
        py = y + 0.5 - ay
        # ① 无限长条带内 |perp| ≤ half 的 px 区间（perp = px*nx + py*ny）
        if abs(nx) < 1e-9:
            if abs(py * ny) > half:
                continue
            lo, hi = -BIG, BIG
        else:
            t0 = (-half - py * ny) / nx
            t1 = (half - py * ny) / nx
            lo, hi = (t0, t1) if t0 <= t1 else (t1, t0)
        # ② 投影落在 [0, length] 内的 px 区间（proj = px*ux + py*uy）
        if abs(ux) < 1e-9:
            if not (0 <= py * uy <= length):
                continue
        else:
            p0 = (0 - py * uy) / ux
            p1 = (length - py * uy) / ux
            q0, q1 = (p0, p1) if p0 <= p1 else (p1, p0)
            lo, hi = max(lo, q0), min(hi, q1)
        if hi <= lo:
            continue
        xl, xr = lo + ax, hi + ax
        buf.solid_span(y, int(math.ceil(xl + aa)), int(math.floor(xr - aa)) + 1, color)
        for x in range(max(0, int(math.floor(xl - aa))), min(buf.w, int(math.ceil(xr + aa)) + 1)):
            px = x + 0.5 - ax
            t = max(0.0, min(length, px * ux + py * uy))
            d = math.hypot(px - t * ux, py - t * uy)
            a = (half + aa - d) / (2.0 * aa)
            if 0 < a < 0.999:
                buf.blend(x, y, color, a)
    disc(buf, ax, ay, half, color, aa)
    disc(buf, bx, by, half, color, aa)


def grid_overlay(buf, x0, y0, side, weight, color, alpha):
    """格纸线：side 内画 GRID_N+1 条横竖线（入参是浮点像素，入口取整）。"""
    x0, y0, side = int(round(x0)), int(round(y0)), int(round(side))
    step = side / GRID_N
    for k in range(GRID_N + 1):
        p = int(x0 + step * k)
        for off in range(max(1, int(weight))):
            x = p + off - int(weight) // 2
            for yy in range(y0, y0 + int(side)):
                buf.blend_span(yy, x, x + 1, color, alpha)
        q = int(y0 + step * k)
        for off in range(max(1, int(weight))):
            yy = q + off - int(weight) // 2
            if alpha >= 0.999:
                buf.solid_span(yy, x0, x0 + int(side), color)
            else:
                buf.blend_span(yy, x0, x0 + int(side), color, alpha)


# ── 图标：墨底 + 格纸 + 一条走完 25 格的黄铜链（两端异色 = 端点 1 与 25）──────────
def render_icon(size, maskable=False):
    buf = Buf(size, size)
    buf.vgrad(INK, INK_LIT)
    pad = size * (0.22 if maskable else 0.085)
    side = size - 2 * pad
    grid_overlay(buf, pad, pad, side, max(1.0, size / 420.0), BRASS_LIT, 0.20)
    pts, step = path_points(size, pad)
    thick = step * 0.155
    for i in range(len(pts) - 1):
        capsule(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], thick, BRASS)
    for i in range(len(pts) - 1):
        capsule(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], thick * 0.42, BRASS_LIT)
    last = len(pts) - 1
    for i, (cx, cy) in enumerate(pts):
        endpoint = i == 0 or i == last
        r = step * (0.315 if endpoint else 0.215)
        disc(buf, cx, cy, r, PAPER)
        disc(buf, cx, cy, r * 0.74, GOOD if i == 0 else (BAD if i == last else BRASS))
    # 数字不写在图标上：实测 192px 下 INK 深字压在深底上只剩黑块，母题靠"格纸 + 一条链 +
    # 两端异色"就够认了；带数字的那张是 og.png（纸盘底，字压在纸上才读得动）。
    return buf


def downsample(src, dw, dh):
    """面积加权盒式缩小（先横后竖）⇒ 1024 母图派生全套尺寸的唯一路子，不引入锐化假边。"""
    sw, sh = src.w, src.h
    rx, ry = sw / float(dw), sh / float(dh)

    def axis(row, n_in, n_out, ratio):
        out = [0] * (n_out * 4)
        for o in range(n_out):
            c0, c1 = o * ratio, (o + 1) * ratio
            i0, i1 = int(math.floor(c0)), int(math.ceil(c1))
            acc = [0.0] * 4
            tot = 0.0
            for i in range(max(0, i0), min(n_in, i1)):
                wgt = min(c1, i + 1) - max(c0, i)
                if wgt <= 0:
                    continue
                base = i * 4
                for k in range(4):
                    acc[k] += row[base + k] * wgt
                tot += wgt
            base = o * 4
            if tot <= 0:
                i = min(n_in - 1, max(0, int((c0 + c1) / 2)))
                for k in range(4):
                    out[base + k] = row[i * 4 + k]
            else:
                for k in range(4):
                    out[base + k] = int(acc[k] / tot + 0.5)
        return out

    mid = [axis(src.rows[y], sw, dw, rx) for y in range(sh)]
    out = Buf(dw, dh)
    for y in range(dh):
        col_rows = [mid[i] for i in range(max(0, int(math.floor(y * ry))), min(sh, int(math.ceil((y + 1) * ry))))]
        wts = [min((y + 1) * ry, i + 1) - max(y * ry, i) for i in range(
            max(0, int(math.floor(y * ry))), min(sh, int(math.ceil((y + 1) * ry))))]
        merged = [0.0] * (dw * 4)
        tot = sum(wts) or 1.0
        for row, wgt in zip(col_rows, wts):
            for j, val in enumerate(row):
                merged[j] += val * wgt
        r = out.rows[y]
        for j, val in enumerate(merged):
            r[j] = int(val / tot + 0.5)
    return out


def render_paper(size=256):
    """可平铺纸纹：只用整数频率的正弦 ⇒ 左右上下严格对接，CSS 平铺看不出接缝。"""
    buf = Buf(size, size, PAPER)
    waves = ((2, 3, 0.50), (4, 1, 0.30), (1, 5, 0.25), (6, 6, 0.12), (3, 7, 0.18))
    amp = sum(w for _, _, w in waves)
    TAU = 2.0 * math.pi
    for y in range(size):
        v = y / size * TAU
        for x in range(size):
            u = x / size * TAU
            n = 0.0
            for fu, fv, w in waves:
                n += w * math.sin(fu * u + fv * v * 1.7)
            t = 0.5 + 0.5 * (n / amp)
            buf.px(x, y, tuple(int(PAPER[i] + (PAPER_ALT[i] - PAPER[i]) * t) for i in range(3)))
    return buf


def render_sparks(frame=64, count=4):
    """粒子图集（4 帧 64×64）：亮核 / 涟漪环 / 链节 / 星芒。fx 层按帧号横向取图集。"""
    buf = Buf(frame * count, frame, (0, 0, 0))
    for f in range(count):
        ox = f * frame
        cx = cy = frame / 2.0
        for y in range(frame):
            for x in range(frame):
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                d = math.hypot(dx, dy) / (frame / 2.0)
                if f == 0:
                    a, col = max(0.0, 1.0 - d) ** 2.2, BRASS_LIT
                elif f == 1:
                    a, col = max(0.0, 1.0 - abs(d - 0.62) / 0.14) ** 1.5, PAPER
                elif f == 2:
                    a = 0.0
                    col = BRASS_LIT
                    for shift in (-0.17, 0.17):
                        sx, sy = dx - shift * frame, dy
                        dd = math.hypot(sx, sy * 1.35) / (frame / 2.0)
                        a = max(a, max(0.0, 1.0 - abs(dd - 0.60) / 0.17))
                else:
                    ang = math.atan2(dy, dx)
                    spike = abs(math.cos(ang * 2.0)) ** 6.0
                    a, col = max(0.0, 1.0 - d / (0.30 + 0.70 * spike)) * max(0.0, 1.0 - d * 0.30), PAPER
                if a > 0.004:
                    buf.put_px(ox + x, y, col, a)
    return buf


def render_glow(size=128):
    """选中格的呼吸光：径向衰减的透明位图（fx 层加色叠上去用）。"""
    buf = Buf(size, size, (0, 0, 0))
    cx = cy = size / 2.0
    for y in range(size):
        for x in range(size):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy) / (size / 2.0)
            a = max(0.0, 1.0 - d) ** 2.6
            buf.put_px(x, y, BRASS_LIT, a * 0.85)
    return buf


def render_og(w=1200, h=630):
    """社交卡：左半一张写满数的 5×5 纸盘（那条链就是母题），右半字标 + 玩法一句话。

    字号一律由 w/h 反推：写死的话换一张卡就糊（实测 600×315 上数字叠成一团，
    而 'HIDATO' 按 scale=20 要 960px 宽，从 x=642 起画在 1200 宽上也溢出右边界）。
    """
    buf = Buf(w, h)
    buf.vgrad(INK, INK_LIT)
    pad = int(h * 0.07)
    side = h - 2 * pad
    step = side / GRID_N
    gap = int(w * 0.045)
    buf.rect(pad, pad, pad + side, pad + side, PAPER)
    grid_overlay(buf, pad, pad, side, 1, LINE, 1.0)
    pts = [(pad + step * (c + 0.5), pad + step * (r + 0.5)) for (r, c) in PATH]
    last = len(pts) - 1
    for i in range(last):
        capsule(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], step * 0.075, BRASS)
    for i, (cx, cy) in enumerate(pts):
        if i in (0, last):
            disc(buf, cx, cy, step * 0.30, GOOD if i == 0 else BAD)
    s_num = max(2, int(step * 0.055))     # 两位数 + 一个字距 = 11s ≤ 0.66*step ⇒ 相邻格不糊成一团
    for i, (cx, cy) in enumerate(pts):
        label = str(i + 1)
        draw_text(buf, label, int(cx - text_width(label, s_num) / 2), int(cy - 3.5 * s_num),
                  s_num, PAPER if i in (0, last) else INK)
    tx = pad + side + gap
    avail = w - tx - gap
    s_big = max(4, int(avail / (6 * (GLYPH_W + 3))))
    ty = int(h * 0.26)
    draw_text(buf, 'HIDATO', tx, ty, s_big, PAPER, tracking=3)
    draw_text(buf, 'CHAIN', tx, ty + int(s_big * 8.6), s_big, BRASS_LIT, tracking=3)
    s_small = max(2, int(s_big * 0.30))
    line_y = ty + int(s_big * 17.6)
    draw_text(buf, 'KING-MOVE NUMBER CHAIN', tx, line_y, s_small, LINE, tracking=1)
    draw_text(buf, '25 CELLS - ONE PROVEN PATH', tx, line_y + int(s_small * 9.0), s_small, LINE, tracking=1)
    draw_text(buf, 'Z-BIZ-GAME', tx, line_y + int(s_small * 19.0), s_small, BRASS, tracking=2)
    for i in range(5):
        capsule(buf, tx + i * s_big * 1.6, ty - s_big * 2.2,
                tx + i * s_big * 1.6 + s_big * 0.9, ty - s_big * 2.2, s_big * 0.22, BRASS_LIT)
    return buf


def write(rel, buf):
    path = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = png_bytes(buf.w, buf.h, buf.rgba_rows())
    with open(path, 'wb') as fh:
        fh.write(data)
    return (rel, buf.w, buf.h, len(data), hashlib.sha256(data).hexdigest()[:12])


def main():
    # 母题自检：链必须走完 25 格、不重复、相邻两格都是国王步（本仓 rules.isAdjacent 的语义）。
    assert len(PATH) == GRID_N * GRID_N and len(set(PATH)) == len(PATH), '母题链不是 25 格不重复'
    for (r0, c0), (r1, c1) in zip(PATH, PATH[1:]):
        assert max(abs(r1 - r0), abs(c1 - c0)) == 1, '母题链上有非国王步：%r→%r' % ((r0, c0), (r1, c1))
    rows = []
    master = render_icon(1024)
    rows.append(write('assets/img/icons/icon-1024.png', master))
    for size, rel in ((512, 'icons/icon-512.png'), (192, 'icons/icon-192.png'),
                      (180, 'icons/apple-touch-icon.png'), (96, 'icons/icon-96.png'),
                      (48, 'icons/favicon-48.png'), (32, 'icons/favicon-32.png'),
                      (16, 'icons/favicon-16.png')):
        rows.append(write(rel, downsample(master, size, size)))
    rows.append(write('icons/icon-maskable-512.png', render_icon(512, maskable=True)))
    rows.append(write('assets/img/og.png', render_og()))
    rows.append(write('assets/img/paper-256.png', render_paper(256)))
    rows.append(write('assets/img/sparks-256.png', render_sparks()))
    rows.append(write('assets/img/glow-128.png', render_glow(128)))
    for rel, w, h, n, sha in rows:
        print('%-36s %4dx%-4d %8d B  sha256:%s' % (rel, w, h, n, sha))
    print('=> %d 张；母题链 %d 格（端点 1 与 %d），色值抄自 css/game.css' % (len(rows), len(PATH), len(PATH)))


if __name__ == '__main__':
    main()
