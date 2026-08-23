/**
 * 中文符号转 Markdown 记号（0.8.0）
 *
 * 中文输入法下，行首的结构记号（`>` `[` `]` `` ``` `` `-` `#` `*` `~`）
 * 需切换中英才能输入。本模块提供固定内置的映射表与转换逻辑：
 * 行首（允许前导空格）输入连续的全角/中文符号后加空格，整串一次性
 * 自动转换为对应 markdown 结构记号，避免中英切换打断写作。
 *
 * 术语定义见 CONTEXT.md「中文符号转 Markdown 记号」。
 *
 * 实现方式：CM6 输入层统一实现（源码/WYSIWYG 共用同一编辑器实例），
 * 通过 transactionFilter 在"键入空格"的事务上叠加转换，合并为一个撤销步。
 */
import {
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

/** 映射表条目（固定内置，设置面板只读展示用） */
export interface FullwidthToMarkdownMapping {
  /** 输入的中文全角符号串（行首） */
  input: string;
  /** 转换后的 markdown 结构记号 */
  output: string;
  /** 备注（如嵌套示例，语言中立，设置面板只读展示用） */
  note?: string;
}

/**
 * 中文符号 → Markdown 结构记号映射表（单一出处）。
 * 转换扩展与设置面板只读展示均从此处取数，避免两处漂移。
 */
export const FULLWIDTH_TO_MARKDOWN_MAPPINGS: FullwidthToMarkdownMapping[] = [
  { input: "》", output: ">", note: "》》 → >>" },
  { input: "···", output: "```" },
  { input: "【】", output: "[]" },
  { input: "·", output: "-" },
  { input: "＊", output: "*" },
  { input: "－", output: "-" },
  { input: "＃", output: "#", note: "＃＃ → ##" },
  { input: "～", output: "~" },
  { input: "＊＊＊", output: "***" },
];

/** 按 input 长度降序的规则表（多字符规则优先，如 `···` 优先于 `·`） */
const RULES_BY_LENGTH: FullwidthToMarkdownMapping[] = [
  ...FULLWIDTH_TO_MARKDOWN_MAPPINGS,
].sort((a, b) => b.input.length - a.input.length);

/** 行首转换结果（行内字符偏移） */
export interface LineStartSymbolConversion {
  /** 替换区间起点（行内字符偏移，符号串起点，跳过前导空格） */
  from: number;
  /** 替换区间终点（行内字符偏移，即光标所在列） */
  to: number;
  /** 替换文本（转换后的记号 + 触发空格） */
  insert: string;
}

/**
 * 行首转换纯函数（T2.1 单测目标）。
 *
 * @param lineText  光标所在行的完整文本
 * @param cursorCol 光标在该行内的字符偏移（0 = 行首）
 * @returns 命中转换规则时返回替换区间与插入文本（行内偏移），否则 null。
 *
 * 规则：
 * - 允许前导空格（`[ \t]*`），转换时保留前导空格。
 * - 对前导空格后的连续符号串做贪心最长匹配 tokenize（多字符规则优先）。
 * - 只要出现无法被映射表消费的字符（即非"行首连续全角符号"），整串不转换。
 * - 触发空格不包含在 `run` 中，由调用方在 `insert` 尾部补充。
 */
export function convertLineStartSymbol(
  lineText: string,
  cursorCol: number
): LineStartSymbolConversion | null {
  if (cursorCol <= 0) return null;
  const prefix = lineText.slice(0, cursorCol);
  const leading = /^[ \t]*/.exec(prefix)![0];
  const run = prefix.slice(leading.length);
  if (run.length === 0) return null;

  let out = "";
  let pos = 0;
  while (pos < run.length) {
    const rule = RULES_BY_LENGTH.find((r) => run.startsWith(r.input, pos));
    if (!rule) return null;
    out += rule.output;
    pos += rule.input.length;
  }
  return { from: leading.length, to: cursorCol, insert: out + " " };
}

/**
 * 判断位置是否落在代码范围内（FencedCode / CodeBlock / InlineCode）。
 * 与 emoji 替换的 collectCodeRanges 同源语法树节点名。
 */
function isInCodeRange(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos + 1) ?? syntaxTree(state);
  let inside = false;
  tree.iterate({
    enter(ref) {
      if (inside || ref.to <= pos) return false;
      if (
        ref.from <= pos &&
        (ref.name === "FencedCode" ||
          ref.name === "CodeBlock" ||
          ref.name === "InlineCode")
      ) {
        inside = true;
        return false;
      }
    },
  });
  return inside;
}

/**
 * 提取"键入单个空格"事务的插入位置。
 * 仅匹配键盘输入（input.type），排除 IME 组合提交（input.type.compose，
 * 组合提交不插入空格字符，且 inserted 通常非单个空格）与粘贴/拖放。
 *
 * @returns 空格插入位置（旧文档坐标）；非单空格键入或含其他改动返回 null。
 */
function insertedTypedSpace(tr: Transaction): number | null {
  const userEvent = tr.annotation(Transaction.userEvent);
  if (typeof userEvent !== "string" || !userEvent.startsWith("input.type")) {
    return null;
  }
  let pos: number | null = null;
  let valid = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    // 纯插入（旧文档无删除 fromA === toA）且插入内容为单个空格
    const isSingleSpace =
      fromA === toA && inserted.length === 1 && inserted.sliceString(0) === " ";
    if (isSingleSpace) {
      if (pos === null) pos = fromA;
      else valid = false; // 多光标同时键入空格 → 不转换
    } else {
      valid = false;
    }
  });
  return valid ? pos : null;
}

/**
 * 中文符号转 Markdown 记号 CM6 扩展。
 *
 * 通过 transactionFilter 在"键入空格"事务上叠加行首转换：
 * - 设置关闭 / 非 markdown 文件 / 代码范围内 → 原样放行。
 * - 命中转换 → 用单个事务替换原事务（符号串 → 记号 + 空格），一个撤销步。
 * - `isEnabled` / `isMarkdown` 为实时谓词（由调用方闭包捕获响应式状态），
 *   因此开关 / 文件切换无需重建扩展即可生效。
 */
export function fullwidthToMarkdownExtension(options: {
  /** 功能开关（实时读取设置，关闭时原样放行） */
  isEnabled: () => boolean;
  /** 当前文件是否为 markdown（.md/.markdown 或未命名新文件） */
  isMarkdown: () => boolean;
}): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!options.isEnabled()) return tr;
    if (!options.isMarkdown()) return tr;

    const pos = insertedTypedSpace(tr);
    if (pos === null) return tr;

    const state = tr.startState;
    const line = state.doc.lineAt(pos);
    const conv = convertLineStartSymbol(line.text, pos - line.from);
    if (!conv) return tr;

    const from = line.from + conv.from;
    if (isInCodeRange(state, from)) return tr;

    // 单个事务完成转换 + 空格，Ctrl+Z 一次还原为原始全角符号
    return {
      changes: { from, to: pos, insert: conv.insert },
      userEvent: "input.fullwidthToMarkdown",
    };
  });
}
