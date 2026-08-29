/**
 * Markdown 管道符表格的解析与规范化核心（T1.1）。
 *
 * 纯函数、无 DOM 依赖，供 WYSIWYG 就地表格编辑（T1.5 写回）复用。
 * 对齐分三态：'l' 左 / 'c' 中 / 'r' 右，来自分隔行 `:---` `:---:` `---:`。
 */

export type CellAlign = "l" | "c" | "r";

export interface TableModel {
  cells: string[][];
  align: CellAlign[];
}

/** 单元格文本 → 显示宽度：CJK/全角/emoji 计 2，其余计 1（补空格对齐用）。 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1100) w += 2;
    else w += 1;
  }
  return w;
}

/** 切分一行成单元格，识别转义竖线 `\|`（不拆分），并还原为 `|`；字面 `<br>` 还原为 `\n`。 */
function splitCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const parts = t.split(/(?<!\\)\|/);
  return parts.map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br>/gi, "\n"));
}

/** 判断一行是否为分隔行（仅含 - 与 :、至少一个 -）。 */
function isSeparator(text: string): boolean {
  return /^:?-{1,}:?$/.test(text);
}

/**
 * 将一段 Markdown 表格源码解析为内存模型。
 * 返回 null 表示非法/非表格。仅处理表格块本身。
 */
export function parseTable(source: string): TableModel | null {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headerCells = splitCells(lines[0]);
  if (headerCells.length === 0) return null;

  // 定位分隔行（第二行或其后首个仅含 -/: 的行）
  let sepIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCells(lines[i]);
    if (parts.length >= 1 && parts.every((a) => isSeparator(a)) && parts.some((a) => a.includes("-"))) {
      sepIndex = i;
      break;
    }
  }
  if (sepIndex === -1) return null;

  const align: CellAlign[] = splitCells(lines[sepIndex]).map((s) => {
    if (s.startsWith(":") && s.endsWith(":")) return "c";
    if (s.endsWith(":")) return "r";
    if (s.startsWith(":")) return "l";
    return "l";
  });

  const cells: string[][] = [headerCells];
  for (let i = sepIndex + 1; i < lines.length; i++) {
    cells.push(splitCells(lines[i]));
  }

  const cols = Math.max(align.length, ...cells.map((r) => r.length));
  for (const row of cells) while (row.length < cols) row.push("");
  while (align.length < cols) align.push("l");

  return { cells, align };
}

function escapeCell(text: string): string {
  // 换行 → 字面 <br>（多行格，GFM 表格内不允许裸换行），竖线 → \|
  return text.replace(/\n/g, "<br>").replace(/\|/g, "\\|");
}

// ===== 结构性操作（T1.4，纯函数） =====

/** 复制模型（避免原地修改共享数组）。 */
export function cloneTable(t: TableModel): TableModel {
  return {
    cells: t.cells.map((r) => r.slice()),
    align: t.align.slice(),
  };
}

function requireCols(t: TableModel, n: number): TableModel {
  const cols = Math.max(n, t.align.length, ...t.cells.map((r) => r.length));
  for (const row of t.cells) while (row.length < cols) row.push("");
  while (t.align.length < cols) t.align.push("l");
  return t;
}

/** 在第 col（0-based）位置前插入空列；col 越界则追加到末尾。 */
export function addColumn(t: TableModel, col: number): TableModel {
  const out = cloneTable(t);
  requireCols(out, out.align.length);
  const at = Math.min(Math.max(0, col), out.align.length);
  for (const row of out.cells) row.splice(at, 0, "");
  out.align.splice(at, 0, "l");
  return out;
}

/** 删除第 col 列；列数少于等于 1 时不允许删除（返回新模型）。 */
export function removeColumn(t: TableModel, col: number): TableModel {
  if (t.align.length <= 1) return cloneTable(t);
  const out = cloneTable(t);
  const at = Math.min(Math.max(0, col), out.align.length - 1);
  for (const row of out.cells) row.splice(at, 1);
  out.align.splice(at, 1);
  return out;
}

/** 在第 row（0-based，含表头）位置前插入空行；row=0 表示表头下第一行。 */
export function addRow(t: TableModel, row: number): TableModel {
  const out = cloneTable(t);
  requireCols(out, out.align.length);
  const at = Math.min(Math.max(1, row), out.cells.length);
  out.cells.splice(at, 0, new Array<string>(out.align.length).fill(""));
  return out;
}

/** 删除第 row 行（0 为表头）；数据行少于等于 1 时不允许删除（返回新模型）。 */
export function removeRow(t: TableModel, row: number): TableModel {
  // 至少保留 表头 + 1 数据行（行数 >= 2）
  if (t.cells.length <= 2) return cloneTable(t);
  const out = cloneTable(t);
  const at = Math.min(Math.max(1, row), out.cells.length - 1);
  out.cells.splice(at, 1);
  return out;
}

/** 设置对齐；返回新模型。 */
export function setAlignment(t: TableModel, col: number, align: CellAlign): TableModel {
  const at = Math.min(Math.max(0, col), t.align.length - 1);
  const out = cloneTable(t);
  out.align[at] = align;
  return out;
}

/**
 * 设置单格文本；返回新模型（不动对齐，改字保留分隔行）。
 * 坐标越界时忽略，返回 clone。
 */
export function setCell(t: TableModel, r: number, c: number, text: string): TableModel {
  const out = cloneTable(t);
  if (c < 0 || c >= out.align.length) return out;
  if (r < 0 || r >= out.cells.length) return out;
  out.cells[r][c] = text;
  return out;
}

/**
 * 规范化表格：按每列最长显示宽补空格对齐管道符；分隔行按对齐符号重建。
 * 单元格内换行（`\n`）写回为字面 `<br>`，按转义后的文本计宽补空格。
 */
export function reflowTable(t: TableModel): string {
  const cols = t.align.length;
  // 先逐格转义（`\n`→`<br>`、`|`→`\|`），再以转义后的文本计算列宽，避免多行格错位
  const rows = t.cells.map((r) => r.slice(0, cols).map(escapeCell));
  const widths = new Array<number>(cols).fill(3);
  for (const row of rows) {
    row.forEach((cell, i) => {
      const w = displayWidth(cell);
      if (w > widths[i]) widths[i] = w;
    });
  }

  const padTo = (text: string, width: number): string => {
    const gap = width - displayWidth(text);
    return gap > 0 ? text + " ".repeat(gap) : text;
  };

  const fmtRow = (cells: string[]): string =>
    "| " + cells.map((c, i) => padTo(c, widths[i])).join(" | ") + " |";

  const sep = t.align.map((a, i) => {
    // 分隔行每列至少 3 个 `-`（GFM 惯例）
    const n = Math.max(3, widths[i] - 1);
    switch (a) {
      case "c":
        return ":" + "-".repeat(n) + ":";
      case "r":
        return "-".repeat(n) + ":";
      default:
        return ":" + "-".repeat(n);
    }
  });

  const [header, ...body] = rows;
  return [fmtRow(header), "| " + sep.join(" | ") + " |", ...body.map(fmtRow)].join("\n");
}