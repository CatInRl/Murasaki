/**
 * WYSIWYG 就地表格编辑器（T1.2-T1.6）。
 *
 * 职责：把一个 markdown 管道符表格渲染为可编辑的 contentEditable <table>，
 * 管理编辑会话（锚点、键盘导航、工具条、悬停胶囊、结构化操作），
 * 并在提交时把当前 DOM 状态收集为 TableModel → reflowTable → 交回给调用方写回。
 *
 * 编辑期策略：所有改动只发生在 DOM（contentEditable），不触碰 CM 文档，
 * 因此 CM 选区/撤销栈保持不变；只有提交（Esc / 失焦 / 结构化操作）时才
 * 通过 onCommit(nextSource) 一次性写回整表。这避免每次击键重建 widget
 * 导致失焦与颤动。
 */
import { TableModel, CellAlign, parseTable, reflowTable, addColumn, removeColumn, addRow, removeRow, setAlignment } from "./tableReflow";

/**
 * 提交回调：把新的 markdown 表格源码交回宿主（wysiwygPlugin 通过事件 → SourceEditor dispatch）。
 * @param nextSource 规范化后的表格源码。
 * @param anchorCell 提交时的锚点单元格（可能为 null，如无聚焦格时由胶囊追加）。
 *                   宿主在写回并重建表格块后可据此把焦点/光标放回同一单元格（“提交并留在表格”）。
 */
export interface TableEditorHooks {
  onCommit: (nextSource: string, anchorCell?: CellCoord | null) => void;
}

/** 单元格相对坐标。 */
export interface CellCoord {
  row: number; // 0 = 表头
  col: number;
}

/**
 * 就地表格编辑器控制器。
 * 单实例绑定一个 <table> DOM，管理单元格交互与结构化操作。
 */
export class TableEditor {
  /** 当前渲染的 DOM <table>。 */
  private table!: HTMLTableElement;
  /** 当前锚点单元格（没有则为 null）。 */
  private anchor: CellCoord | null = null;
  /** 当前模型（DOM 初始化时的快照；结构化操作时同步更新 DOM 与模型）。 */
  private model: TableModel;
  /** 文本改动的 DOM 状态是否已“脏”（结构化操作会重置，文本改动靠提交时统一收集）。 */
  private readonly hooks: TableEditorHooks;
  /** 锚点/结构变化后由宿主挂接的刷新回调（用于工具条可用态更新）。 */
  onAnchorChange?: () => void;

  constructor(source: string, hooks: TableEditorHooks) {
    this.hooks = hooks;
    this.model = parseTable(source) ?? { cells: [], align: [] };
  }

  /** 构建 DOM 到宿主容器。返回 table 元素（供宿主插入）。 */
  render(wrapper: HTMLElement): HTMLTableElement {
    this.table = wrapper.ownerDocument.createElement("table");
    this.table.className = "murasaki-wysiwyg-table-grid";
    this.rebuildTableDOM();
    this.attachEdgeCapsules(wrapper);
    return this.table;
  }

  /** T1.4 悬停插入胶囊：表格右缘(＋列)/底缘(＋行)，无锚点时追加末尾。 */
  private attachEdgeCapsules(wrapper: HTMLElement): void {
    const doc = wrapper.ownerDocument;
    const mkCap = (title: string, className: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = "＋";
      b.title = `${title}（对锚点格生效）`;
      b.className = `murasaki-table-edge-cap ${className}`;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // 防止点击移走单元格焦点
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    wrapper.appendChild(mkCap("锚点格右侧插列", "murasaki-table-edge-cap-right", () => this.addColumnAfterAnchor()));
    wrapper.appendChild(mkCap("锚点格下方插行", "murasaki-table-edge-cap-bottom", () => this.addRowAfterAnchor()));
  }

  /** 用当前 model 重建 <table> 内部结构（含 th/td、对齐样式、事件绑定）。 */
  private rebuildTableDOM(): void {
    if (!this.table) return;
    const doc = this.table.ownerDocument;
    this.table.textContent = "";

    const { cells, align } = this.model;
    const makeCell = (text: string, tag: "th" | "td", row: number, col: number) => {
      const cell = doc.createElement(tag);
      cell.contentEditable = "true";
      cell.spellcheck = false;
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      // 把单元格文本转成跨行安全显示：\n → <br>（Enter 格内换行），保证单格内可编辑多行
      this.setCellLines(cell, text);
      cell.style.textAlign = align[col] === "l" ? "left" : align[col] === "c" ? "center" : "right";
      this.bindCell(cell, row, col);
      return cell;
    };

    const thead = doc.createElement("thead");
    const headTr = doc.createElement("tr");
    cells[0]?.forEach((t, c) => headTr.appendChild(makeCell(t, "th", 0, c)));
    thead.appendChild(headTr);
    this.table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    for (let r = 1; r < cells.length; r++) {
      const tr = doc.createElement("tr");
      cells[r].forEach((t, c) => tr.appendChild(makeCell(t, "td", r, c)));
      tbody.appendChild(tr);
    }
    this.table.appendChild(tbody);
  }

  /** 把文本设为单元格的跨行内容：把 \n 拆成 <br> + 文本节点。 */
  private setCellLines(cell: HTMLTableCellElement, text: string): void {
    cell.textContent = "";
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) cell.appendChild(cell.ownerDocument.createElement("br"));
      cell.appendChild(cell.ownerDocument.createTextNode(lines[i]));
    }
  }

  /** 读取单元格 DOM → 模型单元格文本：把 <br> 还原为 \n。 */
  private readCellText(cell: HTMLTableCellElement): string {
    let out = "";
    for (const node of Array.from(cell.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
      else if (node instanceof HTMLBRElement) out += "\n";
      else out += (node as HTMLElement).textContent ?? "";
    }
    return out;
  }

  /** 绑定一个可编辑 td 单元格的交互。 */
  private bindCell(cell: HTMLTableCellElement, row: number, col: number): void {
    // 聚焦 → 设为锚点；其它单元格清除锚点高亮
    cell.addEventListener("focus", () => {
      this.clearAnchor();
      this.anchor = { row, col };
      cell.classList.add("murasaki-anchor-cell");
      this.onAnchorChange?.();
    });

    this.bindCellInput(cell, row, col);
  }

  /** 单元格 keydown：Tab 导航 / Shift+Tab 反向、Enter 格内换行、Esc 提交留表。 */
  private bindCellInput(cell: HTMLTableCellElement, row: number, col: number): void {
    cell.addEventListener("keydown", (e: KeyboardEvent) => {
      // Enter：格内换行（插入 <br>），不提交
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const sel = cell.ownerDocument.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (range) {
          const br = cell.ownerDocument.createElement("br");
          range.deleteContents();
          range.insertNode(br);
          range.setStartAfter(br);
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return;
      }
      // Esc：提交并留下（整表写回）
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.commit();
        return;
      }
      // Tab / Shift+Tab：横向导航
      if (e.key === "Tab") {
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        this.moveAnchor(col + dir, row);
        return;
      }
      // 方向键：光标到格内文本边界时跨格导航（否则交给浏览器在格内移动光标）
      const nav = this.arrowDelta(e.key);
      if (nav && this.caretAtEdge(cell, e.key)) {
        e.preventDefault();
        this.arrowNavigate(row, col, nav[0], nav[1]);
      }
    });

    // 失焦且不再有内部焦点 → 提交写回
    cell.addEventListener("blur", () => {
      // 延迟到事件循环末尾，让点击工具条/其它单元格的 focus 先发生
      setTimeout(() => {
        const cellEls = Array.from(this.table.querySelectorAll("[data-row]")) as HTMLTableCellElement[];
        if (cellEls.some((c) => c === cell.ownerDocument.activeElement)) return;
        if (this.anchor && this.anchor.row === row && this.anchor.col === col) {
          this.commit();
        }
      }, 0);
    });
  }

  /** 定位单元格 DOM（th/td 通用）。 */
  private cellAt(row: number, col: number): HTMLTableCellElement | null {
    return this.table.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLTableCellElement | null;
  }

  /** 清除锚点高亮。 */
  private clearAnchor(): void {
    this.table.querySelectorAll(".murasaki-anchor-cell").forEach((c) => c.classList.remove("murasaki-anchor-cell"));
  }
  private moveAnchor(nextCol: number, row: number): void {
    const cols = this.model.align.length;
    const rows = this.model.cells.length;
    let r = row;
    let c = nextCol;
    if (c < 0) { c = cols - 1; if (r > 0) r--; else { c = cols - 1; } }
    if (c >= cols) { c = 0; if (r < rows - 1) r++; else { c = 0; } }
    const cell = this.cellAt(r, c);
    if (cell) {
      cell.focus();
      // 光标移到单元格末尾
      const rng = cell.ownerDocument.createRange();
      rng.selectNodeContents(cell);
      rng.collapse(false);
      const sel = cell.ownerDocument.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(rng);
    }
  }

  // ===== 方向键格间导航 =====

  /** 方向键 → [行偏移, 列偏移]。 */
  private arrowDelta(key: string): readonly [number, number] | null {
    switch (key) {
      case "ArrowLeft": return [0, -1];
      case "ArrowRight": return [0, 1];
      case "ArrowUp": return [-1, 0];
      case "ArrowDown": return [1, 0];
      default: return null;
    }
  }

  /**
   * 判断光标是否位于单元格文本的对应边界。
   * 左/上：光标前无内容（行首/单元格顶）才跨格；右/下：光标后无内容才跨格。
   * 多行单元格（<br>）中：上/下只在首/末行触发，单格内换行不误跳。
   */
  private caretAtEdge(cell: HTMLTableCellElement, key: string): boolean {
    const sel = cell.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!cell.contains(range.startContainer)) return false;
    const idx = this.caretIndex(cell, range);
    const { chars } = this.flattenCell(cell);
    const before = chars.slice(0, idx);
    const after = chars.slice(idx);
    switch (key) {
      case "ArrowLeft": return before === "";
      case "ArrowRight": return after === "";
      case "ArrowUp": return before === ""; // 在首行行首才跨到上一格
      case "ArrowDown": return after === ""; // 在末行行尾才跨到下一格
      default: return false;
    }
  }

  /** 把单元格 DOM 拍平为字符序列（文本节点按原样、<br> → \n），供光标边界计算。 */
  private flattenCell(cell: HTMLTableCellElement): { nodes: (Text | HTMLBRElement)[]; chars: string } {
    const nodes: (Text | HTMLBRElement)[] = [];
    let chars = "";
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        nodes.push(node as Text);
        chars += (node as Text).data;
      } else if (node instanceof HTMLBRElement) {
        nodes.push(node);
        chars += "\n";
      } else {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    };
    for (const child of Array.from(cell.childNodes)) walk(child);
    return { nodes, chars };
  }

  /** 计算光标在拍平字符序列中的索引。 */
  private caretIndex(cell: HTMLTableCellElement, range: Range): number {
    const { nodes } = this.flattenCell(cell);
    let idx = 0;
    for (const node of nodes) {
      const len = node instanceof HTMLBRElement ? 1 : node.data.length;
      if (node === range.startContainer) {
        return idx + Math.min(range.startOffset, len);
      }
      idx += len;
    }
    // 容器是单元格本身（罕见）：按子节点偏移近似到行内
    return idx;
  }

  /** 跨格导航：目标行列 clamp（不环绕），并把光标放到目标格起点。 */
  private arrowNavigate(row: number, col: number, dr: number, dc: number): void {
    const rows = this.model.cells.length;
    const cols = this.model.align.length;
    const r = Math.min(Math.max(0, row + dr), rows - 1);
    const c = Math.min(Math.max(0, col + dc), cols - 1);
    this.focusCell(r, c);
  }

  // ===== 结构化操作（T1.4，工具条 / 悬停胶囊触发） =====

  /** 是否可删除列（列数 > 1，边界保护）。 */
  canDeleteColumn(): boolean {
    return this.model.align.length > 1;
  }

  /** 是否可删除行（表头 + 数据行 > 2，边界保护）。 */
  canDeleteRow(): boolean {
    return this.model.cells.length > 2;
  }

  /**
   * 把当前 DOM 的单元格文本改动刷新进 model。
   *
   * 结构操作用的 `this.model` 是编辑器构造时的快照，不包含用户随后在 contentEditable
   * 里输入的未提交文本。若直接 `func(model)` 后 `rebuildTableDOM()`，会依据过期快照重建，
   * 把刚输入的文本清空。因此在应用任何结构改动前，先收集 DOM 里的最新文本回填 model。
   */
  private syncModelFromDom(): void {
    this.model = this.collectModel();
  }

  /** 在锚点列之后插入一列；无锚点则追加末尾。 */
  addColumnAfterAnchor(): CellCoord | null {
    const at = this.anchor ? this.anchor.col + 1 : this.model.align.length;
    this.syncModelFromDom();
    this.model = addColumn(this.model, at);
    this.rebuildTableDOM();
    this.focusCell(this.anchor?.row ?? 1, at);
    this.commit();
    return { row: this.anchor?.row ?? 1, col: at };
  }

  /** 删除锚点列（列数 >1 时）。 */
  removeColumnAtAnchor(): void {
    if (!this.anchor) return;
    this.syncModelFromDom();
    this.model = removeColumn(this.model, this.anchor.col);
    const col = Math.min(this.anchor.col, this.model.align.length - 1);
    this.rebuildTableDOM();
    this.focusCell(1, col);
    this.commit();
  }

  /** 在锚点行之后插入一行。 */
  addRowAfterAnchor(): CellCoord | null {
    const at = this.anchor ? this.anchor.row + 1 : this.model.cells.length;
    this.syncModelFromDom();
    this.model = addRow(this.model, at);
    this.rebuildTableDOM();
    this.focusCell(at, this.anchor?.col ?? 0);
    this.commit();
    return { row: at, col: this.anchor?.col ?? 0 };
  }

  /** 删除锚点行（数据行 >1 时）。 */
  removeRowAtAnchor(): void {
    if (!this.anchor) return;
    this.syncModelFromDom();
    const row = Math.max(1, this.anchor.row);
    this.model = removeRow(this.model, row);
    const r = Math.min(row, this.model.cells.length - 1);
    this.rebuildTableDOM();
    this.focusCell(r, 0);
    this.commit();
  }

  /** 设置锚点列对齐。 */
  setAnchorAlignment(align: CellAlign): void {
    if (!this.anchor) return;
    this.syncModelFromDom();
    this.model = setAlignment(this.model, this.anchor.col, align);
    this.rebuildTableDOM();
    this.focusCell(this.anchor?.row ?? 1, this.anchor.col);
    this.commit();
  }

  /** 当前锚点列的对齐（无锚点返回 null），供工具条对齐按钮激活态。 */
  get activeAlignment(): CellAlign | null {
    if (!this.anchor) return null;
    return this.model.align[this.anchor.col] ?? null;
  }

  /** 锚点横向移动 ±1 列（clamp 到列界，供工具条「上一列/下一列」）。 */
  navigateColumn(delta: 1 | -1): void {
    if (!this.anchor) return;
    const cols = this.model.align.length;
    const next = Math.min(Math.max(0, this.anchor.col + delta), cols - 1);
    if (next !== this.anchor.col) this.focusCell(this.anchor.row, next);
  }

  /** 聚焦指定单元格。 */
  focusCell(row: number, col: number): void {
    this.cellAt(row, col)?.focus();
  }

  // ===== 提交（T1.5 写回） =====

  /**
   * 收集当前 DOM 状态 → TableModel → reflowTable → 交回宿主写回。
   * 文本改动随 DOM 收集；结构化操作已同步 model（含 DOM）。
   */
  private collectModel(): TableModel {
    const rows = this.table.rows;
    const cells: string[][] = [];
    // 表头
    const headerRow = rows[0];
    const header: string[] = [];
    for (let c = 0; c < headerRow.cells.length; c++) {
      header.push(this.readCellText(headerRow.cells[c] as HTMLTableCellElement));
    }
    cells.push(header);
    for (let r = 1; r < rows.length; r++) {
      const rowCells: string[] = [];
      for (let c = 0; c < rows[r].cells.length; c++) {
        rowCells.push(this.readCellText(rows[r].cells[c] as HTMLTableCellElement));
      }
      cells.push(rowCells);
    }
    // 对齐从当前 model 取（HTML 无对齐信息，需回退到 DOM 解析）
    return { cells, align: this.model.align.slice(0, header.length) };
  }

  /** 当前锚点单元格（只读访问，供宿主/工具条判断是否处于编辑态）。 */
  get activeAnchor(): CellCoord | null {
    return this.anchor;
  }

  /** 提交：收集 DOM → 规范化 → onCommit(携带锚点)。之后清除锚点并通知宿主刷新。 */
  commit(): void {
    const anchor = this.anchor;
    if (anchor) this.clearAnchor();
    this.anchor = null;
    const model = this.collectModel();
    // 非法结构（空行）仍可规范化，reflowTable 对空 cells 防御
    const src = reflowTable(model);
    this.onAnchorChange?.();
    this.hooks.onCommit(src, anchor);
  }
}