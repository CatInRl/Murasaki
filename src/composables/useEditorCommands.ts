import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

// 测试工具函数已迁移至 src/test/editorTestUtils.ts（createTestView / setSelection / getDoc）
// 避免污染生产模块接口

/**
 * 段落格式化命令
 * 所有函数都接受 EditorView，直接操作选区/行。
 * 纯函数式：无副作用除了对编辑器本身的 dispatch。
 */

/**
 * 获取当前选区涉及的行范围（1-indexed line numbers）
 */
function getSelectedLineRange(view: EditorView): { fromLine: number; toLine: number } {
  const { from, to } = view.state.selection.main;
  const fromLine = view.state.doc.lineAt(from).number;
  const toLine = view.state.doc.lineAt(to).number;
  return { fromLine, toLine };
}

/**
 * 替换指定行范围的内容（行号 1-indexed）
 * 不显式设置选区，让 CodeMirror 默认映射光标位置（变更后光标仍在合理位置）
 */
function replaceLines(
  view: EditorView,
  fromLine: number,
  toLine: number,
  newLines: string[]
): void {
  const doc = view.state.doc;
  const from = doc.line(fromLine).from;
  const toLineEnd = doc.line(toLine).to;
  const insert = newLines.join("\n");
  view.dispatch({
    changes: { from, to: toLineEnd, insert },
  });
}

/**
 * 获取指定行范围的行内容数组
 */
function getLines(view: EditorView, fromLine: number, toLine: number): string[] {
  const doc = view.state.doc;
  const lines: string[] = [];
  for (let i = fromLine; i <= toLine; i++) {
    lines.push(doc.line(i).text);
  }
  return lines;
}

/**
 * 设置标题层级（level 1-6），level=0 表示取消标题
 * - 若行已是同级别标题：取消（变普通）
 * - 若行是其他级别标题：替换为指定级别
 * - 若行不是标题：添加前缀
 */
export function setHeading(view: EditorView, level: number): void {
  const { fromLine, toLine } = getSelectedLineRange(view);
  const lines = getLines(view, fromLine, toLine);
  const prefix = level > 0 ? "#".repeat(level) + " " : "";
  const headingRegex = /^#{1,6}\s+/;
  const newLines = lines.map((line) => {
    // 移除已有标题前缀
    const stripped = headingRegex.test(line) ? line.replace(headingRegex, "") : line;
    return prefix + stripped;
  });
  replaceLines(view, fromLine, toLine, newLines);
}

/**
 * 切换列表前缀（无序列表 - / 有序列表 1. / 任务列表 - [ ]）
 * - 若行已是该类型列表项：取消
 * - 否则：添加前缀（替换已有列表前缀）
 */
type ListType = "unordered" | "ordered" | "task";

export function toggleList(view: EditorView, type: ListType): void {
  const { fromLine, toLine } = getSelectedLineRange(view);
  const lines = getLines(view, fromLine, toLine);

  // 列表前缀正则：匹配 - / * / + / 1. / - [ ] / - [x]
  const listRegex = /^(\s*)([-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/;
  // 当前类型的检测正则（用于判断行是否已是该类型）
  const typeRegex: Record<ListType, RegExp> = {
    unordered: /^\s*[-*+]\s+/,
    ordered: /^\s*\d+\.\s+/,
    task: /^\s*[-*+]\s+\[[ xX]\]\s+/,
  };

  const newPrefix: Record<ListType, string> = {
    unordered: "- ",
    ordered: "1. ",
    task: "- [ ] ",
  };

  // 判断是否所有行都已是该类型
  const allAlready = lines.every((line) => typeRegex[type].test(line));

  const newLines = lines.map((line) => {
    const match = line.match(listRegex);
    const indent = match ? match[1] : "";
    const stripped = match ? line.slice(match[0].length) : line;
    if (allAlready) {
      // 取消：移除前缀
      return indent + stripped;
    }
    // 添加/替换为指定类型前缀
    return indent + newPrefix[type] + stripped;
  });

  const doc = view.state.doc;
  const from = doc.line(fromLine).from;
  const toLineEnd = doc.line(toLine).to;
  const insert = newLines.join("\n");

  // 目标行 = 光标所在行（相对被处理行的第一个，用于计算光标落点）
  const headLineNum = doc.lineAt(view.state.selection.main.head).number;
  const targetIdx = Math.max(0, Math.min(headLineNum, toLine) - fromLine);
  const targetNewLine = newLines[targetIdx];

  // 计算目标行前缀长度（含缩进）。添加时把光标定位到新前缀之后，
  // 避免光标落在编号/标记前（插入有序列表时光标跑到序号前的问题）。
  let prefixLen = 0;
  const m = targetNewLine.match(listRegex);
  if (m) {
    prefixLen = m[0].length;
  } else if (!allAlready) {
    prefixLen = newPrefix[type].length;
  }

  // 计算目标行在新文档中的起始位置
  let targetLineStart = from;
  for (let i = 0; i < targetIdx; i++) {
    targetLineStart += newLines[i].length + 1; // +1 为换行符
  }

  view.dispatch({
    changes: { from, to: toLineEnd, insert },
    selection: { anchor: targetLineStart + prefixLen },
    userEvent: "input.toggleList",
  });
}

/**
 * 切换代码块：用 ``` 围栏包裹选区
 * - 若选区已在 ``` 块内：移除围栏
 * - 否则：包裹
 */
export function toggleCodeBlock(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);

  // 检查前一行是否是 ``` 开始
  const prevLineNum = fromLine.number - 1;
  const prevLine = prevLineNum >= 1 ? doc.line(prevLineNum).text : "";
  const isStartFence = /^```\s*\w*\s*$/.test(prevLine);

  if (isStartFence) {
    // 已在代码块内，移除围栏
    const afterLineNum = toLine.number + 1;
    const afterLine =
      afterLineNum <= doc.lines ? doc.line(afterLineNum).text : "";
    if (/^```\s*$/.test(afterLine)) {
      const start = doc.line(prevLineNum).from;
      const end = doc.line(afterLineNum).to;
      const innerFrom = fromLine.from;
      const innerTo = toLine.to;
      view.dispatch({
        changes: [
          { from: start, to: innerFrom, insert: "" },
          { from: innerTo, to: end, insert: "" },
        ],
      });
      return;
    }
  }

  // 包裹：在选区前后插入 ```
  const selected = doc.sliceString(from, to);
  const insert = "```\n" + selected + "\n```";
  view.dispatch({
    changes: { from, to, insert },
  });
}

/**
 * 切换引用块：每行添加 > 前缀
 * - 若所有行已是引用：取消
 */
export function toggleBlockquote(view: EditorView): void {
  const { fromLine, toLine } = getSelectedLineRange(view);
  const lines = getLines(view, fromLine, toLine);
  const quoteRegex = /^(\s*)>\s+/;
  const allQuoted = lines.every((line) => quoteRegex.test(line));
  const newLines = lines.map((line) => {
    if (allQuoted) {
      return line.replace(quoteRegex, "$1");
    }
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1] : "";
    return `${indent}> ${line.trimStart()}`;
  });
  replaceLines(view, fromLine, toLine, newLines);
}

/**
 * 切换内联格式（粗体 ** / 斜体 * / 删除线 ~~ / 行内代码 `）
 * - 选区为空：插入标记对，光标置于中间
 * - 选区已被同标记包围（标记在选区外或选区内）：移除标记
 * - 否则：用标记包围选区
 */
export function toggleInline(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;

  if (from === to) {
    // 空选区：插入 marker+marker，光标在中间
    const insert = marker + marker;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + marker.length },
      userEvent: "input.toggleInline",
    });
    return;
  }

  const selected = doc.sliceString(from, to);

  // 选区自身被标记包围（如选中 "**bold**"）
  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= marker.length * 2
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
      userEvent: "input.toggleInline",
    });
    return;
  }

  // 选区两侧紧邻同名标记
  const before = doc.sliceString(Math.max(0, from - marker.length), from);
  const after = doc.sliceString(to, Math.min(doc.length, to + marker.length));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: to, to: to + marker.length, insert: "" },
        { from: from - marker.length, to: from, insert: "" },
      ],
      selection: { anchor: from - marker.length, head: to - marker.length },
      userEvent: "input.toggleInline",
    });
    return;
  }

  // 包围选区
  const insert = marker + selected + marker;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length },
    userEvent: "input.toggleInline",
  });
}

/**
 * 在当前选区插入链接 [text](url)，选区文字作为默认链接文字
 */
export function insertLink(view: EditorView, url: string, text: string): void {
  const sel = view.state.selection.main;
  const insert = `[${text}](${url})`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: "input.insert",
  });
}

/**
 * 在当前选区插入图片 ![alt](url)，选区文字作为默认替代文字
 */
export function insertImage(view: EditorView, url: string, alt: string): void {
  const sel = view.state.selection.main;
  const insert = `![${alt}](${url})`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: "input.insert",
  });
}

/**
 * 判断光标列位置是否落在某行的内联标记对内（如 **bold** 中的光标）
 */
function isCursorInInline(lineText: string, col: number, marker: string): boolean {
  let idx = 0;
  while (idx <= lineText.length - marker.length) {
    const open = lineText.indexOf(marker, idx);
    if (open < 0) break;
    const close = lineText.indexOf(marker, open + marker.length);
    if (close < 0) break;
    if (col > open && col < close) return true;
    idx = close + marker.length;
  }
  return false;
}

/**
 * 计算当前选区/光标所在位置的活跃格式集合（供工具栏高亮激活态）
 */
export function getActiveFormats(view: EditorView): Set<string> {
  const active = new Set<string>();
  const { from, to, head } = view.state.selection.main;
  const doc = view.state.doc;

  const inlineMarkers: Record<string, string> = {
    bold: "**",
    italic: "*",
    strikethrough: "~~",
    code: "`",
  };
  for (const [id, marker] of Object.entries(inlineMarkers)) {
    if (from !== to) {
      const selected = doc.sliceString(from, to);
      if (
        selected.startsWith(marker) &&
        selected.endsWith(marker) &&
        selected.length >= marker.length * 2
      ) {
        active.add(id);
        continue;
      }
      const before = doc.sliceString(Math.max(0, from - marker.length), from);
      const after = doc.sliceString(to, Math.min(doc.length, to + marker.length));
      if (before === marker && after === marker) {
        active.add(id);
      }
    } else {
      const lineObj = doc.lineAt(head);
      const col = head - lineObj.from;
      if (isCursorInInline(lineObj.text, col, marker)) {
        active.add(id);
      }
    }
  }

  const line = doc.lineAt(head).text;
  if (/^###\s/.test(line)) active.add("h3");
  else if (/^##\s/.test(line)) active.add("h2");
  else if (/^#\s/.test(line)) active.add("h1");
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) active.add("task-list");
  else if (/^\s*\d+\.\s+/.test(line)) active.add("ordered-list");
  else if (/^\s*[-*+]\s+/.test(line)) active.add("unordered-list");
  if (/^\s*>\s+/.test(line)) active.add("blockquote");

  return active;
}

/**
 * 插入水平分隔线：在当前行下方插入 ---
 */
export function insertHorizontalRule(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  // 在行末插入：\n\n---\n
  const insertPos = line.to;
  const lineEnd = line.text.length;
  const prefix = lineEnd > 0 ? "\n\n" : "\n";
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: `${prefix}---\n` },
  });
}

/**
 * 插入表格模板
 * @param rows 行数（不含表头）
 * @param cols 列数
 */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const lines: string[] = [];
  // 表头
  lines.push(`| ${Array(safeCols).fill("标题").join(" | ")} |`);
  // 分隔行
  lines.push(`| ${Array(safeCols).fill("---").join(" | ")} |`);
  // 数据行
  for (let i = 0; i < safeRows; i++) {
    lines.push(`| ${Array(safeCols).fill("").join(" | ")} |`);
  }
  const table = lines.join("\n");

  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const insertPos = line.to;
  const prefix = line.text.length > 0 ? "\n\n" : "\n";
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: `${prefix}${table}\n` },
  });
}

/**
 * 自定义 Enter 键处理器：引用块场景确保换行时保持正确的 `>` 层级。
 *
 * 问题：@codemirror/lang-markdown 的 insertNewlineContinueMarkup 在某些嵌套引用块
 * 场景下会错误地增加层级。此处理器在引用块上下文中显式控制换行行为：
 * - 非空行：插入相同层级的前缀 `> > ` 等
 * - 空行（只有前缀）：退出引用块（去掉前缀，或减少一层）
 * - 引用块内含列表标记：交给默认处理器（insertNewlineContinueMarkup 处理列表续行）
 * - 非引用块行：返回 false 交给默认处理器
 */
export function handleEnterInBlockquote(view: EditorView): boolean {
  const sel = view.state.selection.main;
  // 只处理光标（无选区）场景
  if (sel.from !== sel.to) return false;
  const head = sel.head;
  const doc = view.state.doc;
  const line = doc.lineAt(head);

  // 匹配行首的引用块前缀：可选空白 + 一个或多个 `> ` 组合
  const prefixMatch = /^(\s*)((?:>\s*)+)/.exec(line.text);
  if (!prefixMatch) return false; // 非引用块行

  const fullPrefix = prefixMatch[0];
  const leadingWhitespace = prefixMatch[1];
  const quotePart = prefixMatch[2];

  // 统计 `>` 层级
  const quoteLevel = (quotePart.match(/>/g) || []).length;
  if (quoteLevel === 0) return false;

  // 引用块前缀之后的内容
  const contentAfterPrefix = line.text.slice(fullPrefix.length);

  // 如果前缀后面有列表标记（- * + 或 数字.），交给默认处理器处理列表续行
  if (/^\s*([-*+]\s+|\d+[.)]\s+)/.test(contentAfterPrefix)) {
    return false;
  }

  // 判断是否为空行（只有前缀，没有实际内容）
  const isEmptyLine = contentAfterPrefix.trim() === "";

  if (isEmptyLine) {
    // 空行：退出引用块
    if (quoteLevel <= 1) {
      // 单层引用：完全退出（删除前缀，保留行）
      view.dispatch({
        changes: { from: line.from, to: line.from + fullPrefix.length, insert: "" },
        selection: { anchor: line.from },
        userEvent: "input.delete",
      });
    } else {
      // 多层引用：减少一层（去掉最后一个 `>` 及其后随空白）
      const lastGt = quotePart.lastIndexOf(">");
      const newQuotePart = quotePart.slice(0, lastGt).replace(/\s+$/, "");
      const newPrefix = leadingWhitespace + newQuotePart + (newQuotePart ? " " : "");
      view.dispatch({
        changes: { from: line.from, to: line.from + fullPrefix.length, insert: newPrefix },
        selection: { anchor: line.from + newPrefix.length },
        userEvent: "input.delete",
      });
    }
    return true;
  }

  // 非空行：换行并保持相同层级
  // 去除光标前的尾部空白（避免行末多余空格）
  let from = head;
  while (from > line.from + fullPrefix.length && /\s/.test(line.text.charAt(from - line.from - 1))) {
    from--;
  }

  // 构建新行前缀：与前一行完全相同的引用前缀
  const insert = "\n" + fullPrefix;
  view.dispatch({
    changes: { from, to: head, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input",
  });
  return true;
}

/**
 * 段落快捷键 keymap 扩展
 * 返回一个高优先级 keymap，捕获 Enter（引用块换行）、Ctrl+1-6/0、Ctrl+Shift+K/Q/X/[/]
 */
export function paragraphKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      // Enter：引用块换行处理（仅在引用块上下文生效，其他场景 fallthrough 到默认处理器）
      {
        key: "Enter",
        run: (v) => handleEnterInBlockquote(v),
      },
      // Ctrl+1 ~ Ctrl+6：标题
      {
        key: "Ctrl-1",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 1);
          return true;
        },
      },
      {
        key: "Ctrl-2",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 2);
          return true;
        },
      },
      {
        key: "Ctrl-3",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 3);
          return true;
        },
      },
      {
        key: "Ctrl-4",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 4);
          return true;
        },
      },
      {
        key: "Ctrl-5",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 5);
          return true;
        },
      },
      {
        key: "Ctrl-6",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 6);
          return true;
        },
      },
      // Ctrl+0：普通（取消标题）
      {
        key: "Ctrl-0",
        preventDefault: true,
        run: (v) => {
          setHeading(v, 0);
          return true;
        },
      },
      // Ctrl+Shift+K：代码块
      {
        key: "Ctrl-Shift-k",
        preventDefault: true,
        run: (v) => {
          toggleCodeBlock(v);
          return true;
        },
      },
      // Ctrl+Shift+Q：引用块
      {
        key: "Ctrl-Shift-q",
        preventDefault: true,
        run: (v) => {
          toggleBlockquote(v);
          return true;
        },
      },
      // Ctrl+Shift+]：无序列表
      {
        key: "Ctrl-Shift-]",
        preventDefault: true,
        run: (v) => {
          toggleList(v, "unordered");
          return true;
        },
      },
      // Ctrl+Shift+[：有序列表
      {
        key: "Ctrl-Shift-[",
        preventDefault: true,
        run: (v) => {
          toggleList(v, "ordered");
          return true;
        },
      },
      // Ctrl+Shift+X：任务列表
      {
        key: "Ctrl-Shift-x",
        preventDefault: true,
        run: (v) => {
          toggleList(v, "task");
          return true;
        },
      },
    ])
  );
}
