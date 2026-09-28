// DOM 渲染 · Hidato 棋盘（R×C 格）+ 数字面板
//
// 这里**不做任何判定**：盘该不该出货、冲突在哪条边上、这个数能不能写，全部是 js/engine/ 与
// js/ui/game.js 的事；本文件只把它们算好的读数写成 DOM 属性与 class。
// 浏览器闸读的就是这些属性：`[data-cell]` 的 data-value / data-given / data-conflict，
// `[data-value]`（面板钮）的 aria-pressed，以及命中盒（getBoundingClientRect + elementFromPoint）。
//
// 两个被本组织踩过的坑写死在这里：
//   ① 节点**只在几何变化时重建**（换档位）。每次落子都 replaceChildren 的话，
//      键盘用户刚按完 Enter 的那枚按钮会被甩出文档（焦点掉回 body），
//      而且闸手里那批旧节点脱离文档后命中盒变成 0×0，控件明明在屏幕上却测不出形状。
//      所以落子只改属性，不换节点。
//   ② 尺寸只由 CSS 与视口决定（css/game.css 的 --cell 与 clamp），本文件不量容器宽、
//      不设内联像素 ⇒ 390×844 上格子缩到能点、且不出现横向滚动条，这一条由 CSS 单独负责。

/** 档位键 + 格数决定节点形状；同一档换 seed 不需要重建。 */
function boardSig(game) { return `${game.tierKey}:${game.R}x${game.C}`; }

export class BoardView {
  /** @param boardEl #board-wrap 里的棋盘容器 @param paletteEl #palette 数字面板 */
  constructor(boardEl, paletteEl) {
    this.board = boardEl;
    this.palette = paletteEl;
    this.cells = [];
    this.buttons = [];
  }

  /** 建格盘与面板：只在几何变了（换档）时才动节点。 */
  build(game) {
    const sig = boardSig(game);
    if (this.board.dataset.sig === sig && this.cells.length === game.n) return false;
    this.board.replaceChildren();
    this.cells = [];
    for (let c = 0; c < game.n; c++) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cell';
      el.tabIndex = -1;                                  // Tab 不在 49 个格里爬；方向键走选中态
      el.dataset.cell = String(c);
      el.dataset.value = '0';
      el.addEventListener('click', () => this.onCell && this.onCell(c));
      this.board.append(el);
      this.cells.push(el);
    }
    this.board.dataset.sig = sig;
    this.board.style.setProperty('--cols', String(game.C));
    this.board.style.setProperty('--rows', String(game.R));
    this.palette.replaceChildren();
    this.buttons = [];
    for (let v = 1; v <= game.n; v++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'num';
      b.textContent = String(v);
      b.dataset.value = String(v);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.onNumber && this.onNumber(v));
      this.palette.append(b);
      this.buttons.push(b);
    }
    this.palette.dataset.sig = sig;
    this.palette.style.setProperty('--nums', String(game.n));
    return true;
  }

  /**
   * 把模型读数刷到 DOM 上（幂等：只改属性，不建节点）。
   * @param game 模型
   * @param o    {conflict:Set<number>, brokenEdges:Set<number>, hint:number, armed:number, proven:boolean}
   *   conflict 是"这条边断了"的格号集合，brokenEdges 是断掉的那个 v —— 都由 ui/game.js 算好交进来。
   */
  sync(game, o = {}) {
    const n = game.n;
    for (let c = 0; c < n; c++) {
      const el = this.cells[c];
      if (!el) continue;
      const v = game.valueAt(c);
      const given = game.isGiven(c);
      el.dataset.value = String(v);
      if (given) el.dataset.given = '1'; else delete el.dataset.given;
      if (o.conflict && o.conflict.has(c)) el.dataset.conflict = '1'; else delete el.dataset.conflict;
      if (o.hint === c) el.dataset.hint = '1'; else delete el.dataset.hint;
      if (game.sel === c) { el.dataset.selected = '1'; el.setAttribute('aria-current', 'true'); }
      else { delete el.dataset.selected; el.setAttribute('aria-current', 'false'); }
      el.textContent = v ? String(v) : '';
      el.classList.toggle('filled', !!v && !given);
      el.classList.toggle('given', given);
      el.setAttribute('aria-label', `${game.name(c)} · ${given ? `印着 ${v}` : v ? `你写的 ${v}` : '空'}`);
    }
    for (const b of this.buttons) {
      const v = Number(b.dataset.value);
      const used = game.holdsValue(v);
      const printed = game.clueGiven[v] >= 0;
      if (printed) b.dataset.given = '1'; else delete b.dataset.given;
      if (used && !printed) b.dataset.placed = '1'; else delete b.dataset.placed;
      b.setAttribute('aria-pressed', String(o.armed === v));
      b.setAttribute('aria-disabled', String(printed));
      b.classList.toggle('done', used);
    }
    this.board.dataset.filled = String(game.filled());
    this.board.dataset.need = String(n - game.filled());
    this.board.dataset.n = String(n);
  }

  /** 一格的命中矩形（相对视口）；闸用它算"这一点该落在哪格"。 */
  cellRect(cell) {
    const el = this.cells[cell];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cell };
  }
  /** 视口坐标 → 格号（elementFromPoint 的真实命中盒，不是我算的格子尺寸）。 */
  cellFromPoint(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const hit = el && el.closest ? el.closest('[data-cell]') : null;
    return hit ? Number(hit.dataset.cell) : -1;
  }
  /** 焦点是否在盘上（键盘腿要在焦点离开时也能走，闸会测这一条）。 */
  focusBoard() { if (this.board.focus) this.board.focus({ preventScroll: false }); }
}

/** 面板/格盘的可见形状：窄视口上闸要确认控件没被挡（本文件不量尺寸，这条交给 CSS）。 */
export function measure(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
}
