/**
 * WYSIWYG ViewPlugin（Ticket #72 / T7.1）。
 *
 * CodeMirror 6 ViewPlugin：遍历 @codemirror/lang-markdown 语法树，对行级语法标记
 * 应用 hide/dim decoration（光标在当前段 → dim；离开 → hide / 替换为 widget）。
 *
 * Decoration 计算逻辑提取为纯函数 computeDecorations（便于单元测试），本文件负责：
 * - 把描述符转换为 CodeMirror DecorationSet
 * - 监听 selection / doc / viewport 变化（防抖 50ms）
 * - 大文档（>10000 行）仅计算可见视口
 * - Agent 提案覆盖范围不隐藏标记（提案优先级高于 WYSIWYG 隐藏）
 *
 * 详见 ADR-0008（CodeMirror 6 内 WYSIWYG / Typora 路线）。
 */
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { proposalField } from "../../agent/proposals";
import {
  computeDecorations,
  ComputedDeco,
  DEBOUNCE_MS,
  LARGE_DOC_LINE_THRESHOLD,
} from "./computeDecorations";

// ===== Widgets =====

/** 无序列表 bullet（替换 `-`/`*`/`+` 标记）。 */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "murasaki-wysiwyg-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 分隔线（替换 `---`/`***`/`___`）。 */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "murasaki-wysiwyg-hr";
    return div;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// ===== 描述符 → CodeMirror Decoration =====

function toDecorationSet(decos: ComputedDeco[]): DecorationSet {
  const ranges = decos.map((d) => {
    if (d.type === "mark") {
      const cls =
        d.kind === "hide" ? "murasaki-wysiwyg-mark-hide" : "murasaki-wysiwyg-mark-dim";
      return Decoration.mark({ class: cls }).range(d.from, d.to);
    }
    if (d.type === "replace") {
      const widget = d.widget === "bullet" ? new BulletWidget() : new HrWidget();
      return Decoration.replace({ widget }).range(d.from, d.to);
    }
    return Decoration.mark({ class: d.cssClass }).range(d.from, d.to);
  });
  return Decoration.set(ranges, true);
}

// ===== Agent 提案范围（提案覆盖的标记不隐藏） =====

function getProposalRanges(state: EditorState): Array<{ from: number; to: number }> {
  const set = state.field(proposalField, false);
  if (!set) return [];
  return set.proposals
    .filter((p) => p.status === "pending")
    .map((p) => ({ from: p.from, to: p.to }));
}

// ===== ViewPlugin =====

class WysiwygPluginValue {
  decorations: DecorationSet;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(view: EditorView) {
    this.decorations = this.compute(view);
  }

  private compute(view: EditorView): DecorationSet {
    const state = view.state;
    const decos = computeDecorations({
      doc: state.doc.toString(),
      selectionHead: state.selection.main.head,
      tree: syntaxTree(state),
      proposalRanges: getProposalRanges(state),
      viewport:
        state.doc.lines > LARGE_DOC_LINE_THRESHOLD
          ? { from: view.viewport.from, to: view.viewport.to }
          : undefined,
    });
    return toDecorationSet(decos);
  }

  update(u: ViewUpdate): void {
    if (!u.docChanged && !u.selectionSet && !u.viewportChanged) return;
    // 防抖 50ms：合并连续光标移动 / 输入，避免每次按键都重算语法树遍历。
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      this.decorations = this.compute(u.view);
      // 空事务触发 CM6 重新读取 decorations getter（getter 返回新的 DecorationSet）。
      u.view.dispatch([]);
    }, DEBOUNCE_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

/** WYSIWYG ViewPlugin —— 叠加到现有 CodeMirror 编辑器即可启用 WYSIWYG 隐藏。 */
export const wysiwygPlugin = ViewPlugin.fromClass(WysiwygPluginValue, {
  decorations: (v) => v.decorations,
});

/** WYSIWYG 所需样式（标记隐藏/dim、bullet、分隔线、引用块左边框）。 */
export const wysiwygTheme = EditorView.theme({
  ".murasaki-wysiwyg-mark-hide": {
    display: "none",
  },
  ".murasaki-wysiwyg-mark-dim": {
    opacity: "0.4",
    fontSize: "80%",
  },
  ".murasaki-wysiwyg-blockquote": {
    borderLeft: "3px solid var(--murasaki-purple-300, #d8b4fe)",
    paddingLeft: "10px",
    color: "var(--murasaki-ink-2, #525252)",
  },
  ".murasaki-wysiwyg-bullet": {
    color: "var(--murasaki-primary, #9333ea)",
    paddingRight: "6px",
    userSelect: "none",
  },
  ".murasaki-wysiwyg-hr": {
    display: "block",
    borderBottom: "2px solid var(--murasaki-line, #e5e5e5)",
    margin: "6px 0",
    height: "0",
  },
});

/**
 * 一键启用 WYSIWYG：ViewPlugin + 主题。
 * 在 SourceEditor.vue 中通过 Compartment 按模式（source/split/wysiwyg）叠加/移除。
 */
export const wysiwygExtensions = [wysiwygPlugin, wysiwygTheme];
