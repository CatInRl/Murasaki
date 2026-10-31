/**
 * 编辑器内的链接点击（#505）—— 源码模式与所见即所得共用一套判定。
 *
 * 行为约定（与 PreviewPane / WYSIWYG 的 LinkWidget 对齐）：
 * - **Ctrl / Cmd + 点击** 链接 → 打开：外部 URL 交给系统浏览器，相对 `.md` 在应用内新标签打开
 * - 普通点击 → 不拦截，保持「定位光标、编辑原始 markdown」的编辑模型
 * - **不因为 Ctrl+点击产生多光标**：CodeMirror 6 默认 `clickAddsSelectionRange` 在
 *   Windows 上是 `event.ctrlKey`，所以 Ctrl+点击会被当成「加选区」。这里把它改成
 *   只认 Alt，从而让 Ctrl+点击专属于链接跳转（Alt+点击仍然可以加光标）。
 */
import { EditorView } from "@codemirror/view";
import { isExternalUrl } from "../utils/url";

/** 文档中某一位置对应的链接 */
export interface MarkdownLinkAt {
  /** 链接源码起止位置（含方括号与圆括号） */
  from: number;
  to: number;
  /** 目标地址（不含尖括号与可选 title） */
  url: string;
}

/**
 * 找出 `pos` 所在行内、覆盖该位置的 markdown 链接 `[text](url)`。
 *
 * 纯函数，便于单测。图片语法 `![alt](src)` **不算**链接（点击图片不应跳转）。
 *
 * 只扫当前行：markdown 的链接语法不能跨行，逐行匹配既够用也避免了跨行正则的
 * 回溯开销（长文档里每次点击都会跑一次）。
 */
export function findMarkdownLinkAt(doc: string, pos: number): MarkdownLinkAt | null {
  if (pos < 0 || pos > doc.length) return null;

  const lineStart = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const rawEnd = doc.indexOf("\n", pos);
  const lineEnd = rawEnd === -1 ? doc.length : rawEnd;
  const line = doc.slice(lineStart, lineEnd);

  // [text](url) 或 [text](<url>) 或 [text](url "title")
  const linkRe = /\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(line)) !== null) {
    const from = lineStart + match.index;
    // 图片语法：`![alt](src)`，`match.index` 前一个字符是 `!`
    const isImage = from > lineStart && doc[from - 1] === "!";
    if (isImage) continue;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      const raw = match[2];
      const url = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
      return { from, to, url };
    }
  }
  return null;
}

/** 打开链接的两个出口（由调用方注入，便于测试与复用） */
export interface LinkOpenHandlers {
  openExternal(url: string): void;
  openInternal(path: string): void;
}

/**
 * 关掉 CodeMirror 默认的「Ctrl+点击加选区」。
 *
 * 只保留 Alt+点击加光标 —— 否则 Ctrl+点击会被 CM 先当成加选区，链接跳转
 * 就变成了「多光标 + 没跳转」，正是 #505 描述的现象。
 */
export const noCtrlClickAddsSelection = EditorView.clickAddsSelectionRange.of(
  (event: MouseEvent) => event.altKey
);

/** Ctrl/Cmd + 点击链接 → 打开；普通点击不拦截 */
export function linkClickExtension(handlers: LinkOpenHandlers) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;
      if (!event.ctrlKey && !event.metaKey) return false;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const link = findMarkdownLinkAt(view.state.doc.toString(), pos);
      if (!link) return false;

      // 阻止 CM 把这次点击当成选区操作
      event.preventDefault();
      if (isExternalUrl(link.url)) {
        handlers.openExternal(link.url);
      } else {
        handlers.openInternal(link.url);
      }
      return true;
    },
  });
}
