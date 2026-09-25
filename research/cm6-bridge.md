# CodeMirror 6 Agent 工具桥接架构调研

> **Wayfinder Ticket**: [R2](https://github.com/CatInRl/Murasaki/issues/10)
> **相关 Ticket**: [T1 循环架构](https://github.com/CatInRl/Murasaki/issues/2) · [T5 提议 UI](https://github.com/CatInRl/Murasaki/issues/7)
> **日期**: 2026-07-27
> **研究分支**: `research/cm6-bridge`

---

## 1. Executive Summary

Murasaki 现有 CM6 封装（`SourceEditor.vue`）**已经通过 `defineExpose({ getView })` 暴露 `EditorView` 实例**，App.vue 与多个 composable（`useImagePaste` / `useScrollSync`）已经以「`getEditorView: () => EditorView | null` 回调」的方式访问它。这是项目既定的桥接模式，agent 工具应**沿用而非另起**。

关键发现：

1. **单一 EditorView 架构**：当前 `EditorPane` 同时只挂载一个实例，切换 tab 不销毁 view，而是用 `view.dispatch({ changes: { from: 0, to, insert } })` 覆盖文档。这意味着「活跃 tab 的 view」≈「唯一 view」，agent 工具定位成本极低。但也意味着**每个 tab 的独立 undo 栈/选区/视口状态无法跨切换保留**——这是已知的项目行为，agent 工具需尊重此约束。
2. **undo 栈隔离可行**：CM6 `Transaction.addToHistory` 注解 + StateField 双管齐下，可以让 agent 提议在「未接受前完全不进 undo 栈」「接受后进栈可被 Ctrl+Z 撤销」，完全符合项目硬约束「Ctrl+Z 仅限编辑器内容」。
3. **工具纯函数化**：所有「读」类工具都可以写成 `(state: EditorState) => T` 的纯函数，独立于 DOM，vitest 直接 `EditorState.create({ doc })` 即可单测，零 jsdom 依赖。
4. **不需要重构现有 provide/inject 或把 view 塞进 Pinia**：现有 `getEditorView` 回调模式已足够；只需新增一个轻量级 Pinia store（`useEditorBridgeStore`）作为 agent 工具的统一入口，避免「每个工具都拿 `editorRef`」造成的耦合。

---

## 2. Current CM6 Wrapper Findings

### 2.1 关键文件清单

| 文件 | 角色 |
|---|---|
| `src/components/SourceEditor.vue` | **CM6 EditorView 的真正宿主**。`onMounted` 时 `new EditorView({...})`，存于 `shallowRef<EditorView | null> viewRef`，`onBeforeUnmount` 时 `view.destroy()`。 |
| `src/components/EditorPane.vue` | 分屏容器，内含 `SourceEditor` + `PreviewPane`，通过 `editorRef.value?.getView()` 转发 view 给父组件。 |
| `src/App.vue` | 持有 `editorRef = ref<InstanceType<typeof EditorPane> | null>`，所有菜单命令通过 `editorRef.value?.getView()` 调 CM6 API。还在 `onMounted` 中 `window.__editorRef__ = editorRef`（注释说明仅 E2E 测试用）。 |
| `src/composables/useEditorCommands.ts` | 段落格式化命令（`setHeading` / `toggleList` / `toggleCodeBlock` 等），签名为 `(view: EditorView) => void`，**纯函数除 dispatch 外无副作用**，含测试辅助 `createTestView` / `setSelection` / `getDoc`。 |
| `src/composables/useScrollSync.ts` | 双向滚动同步，构造时接收 `editorView: () => EditorView \| null` 回调，调用 `view.lineBlockAtHeight(scrollTop)`、`view.state.doc.lineAt(block.from)`。 |
| `src/composables/useImagePaste.ts` | 图片粘贴/拖入，构造时接收 `getEditorView: () => EditorView \| null`，调用 `view.state.selection.main.head` + `view.dispatch({ changes, selection })`。 |
| `src/stores/useTabsStore.ts` | Pinia store，管理 `tabs: Tab[]` / `activeTabId` / `activeTab`，**不持有任何 EditorView 实例**。Tab 切换通过 `switchTo(tabId)` 改 `activeTabId`，触发 App.vue 中 `activeContent` computed 的 setter 调用 `updateContent()`。 |

### 2.2 View 实例的持有与暴露路径

```
SourceEditor.vue
  └─ viewRef: ShallowRef<EditorView | null>  ← 唯一真正持有者
  └─ defineExpose({ getView: () => viewRef.value, focus, getScrollDom, scrollToLine })
       │
       ▼
EditorPane.vue
  └─ editorRef = ref<InstanceType<typeof SourceEditor>>()
  └─ defineExpose({ getView, focus, scrollToLine })
       │
       ▼
App.vue
  └─ editorRef = ref<InstanceType<typeof EditorPane>>()
  └─ 直接调用 editorRef.value?.getView()  (12 处)
  └─ window.__editorRef__ = editorRef  (E2E 测试注入)
  └─ 传给 composables:
       ├─ useScrollSync({ editorView: () => editorRef.value?.getView() ?? null })
       └─ useImagePaste({ getEditorView: () => editorRef.value?.getView() ?? null })
```

### 2.3 现有暴露机制评估

**优点**

- **零重构即可访问**：agent 工具能直接复用 `editorRef.value?.getView()`，与 `useImagePaste` 同模式。
- **生命周期安全**：`shallowRef` + `onBeforeUnmount destroy` + `getView()` 返回 `null` 的容错，调用方需做 null 检查但不会悬挂引用。
- **测试钩子已就位**：`window.__editorRef__` 是 E2E 测试的稳定入口，agent 工具的 E2E 也可走同一通道。

**Gaps（需补齐才能支撑 agent 工具）**

| Gap | 影响 | 推荐处理 |
|---|---|---|
| **G1. View 访问散落在 App.vue 与各 composable，无统一服务定位器** | agent 工具若直接读 `editorRef`，会与 App.vue 强耦合；若每个工具独立注入 `getEditorView` 回调，工具注册需 N 处改动 | 新增 `useEditorBridgeStore`（Pinia），由 `App.vue` 在 `onMounted` 调用 `bridge.setActiveViewGetter(() => editorRef.value?.getView() ?? null)`，agent 工具全部走 `bridge.getActiveView()` |
| **G2. 切 tab 时旧 view 的 undo 栈/选区丢失** | 用户切走再切回，Ctrl+Z 不能跨切换撤销；agent 提议若跨 tab 切换也会丢 | 现有项目行为，agent 工具约束为「仅在当前活跃 tab 操作」，提议生命周期 < 一次 tab 切换 |
| **G3. 无机制让外部代码收到「view ready / destroyed」通知** | agent 循环可能启动时 view 还未挂载（如欢迎页状态），工具调用 `getActiveView()` 返回 null | 工具实现统一返回 `{ ok: false, error: "no_active_view" }`；上层编排器负责重试或提示 |
| **G4. 没有现存 StateField 用于提议编辑** | T5 提议 UI 需要绿色/红色装饰，现有 extensions 无此机制 | 新增 `proposalField` StateField + `proposeEdit`/`acceptProposal`/`rejectProposal` StateEffect（见 §5） |

---

## 3. Recommended Bridge Architecture

### 3.1 三层架构

```
┌──────────────────────────────────────────────────────────────┐
│  Agent Loop (T1)  ←  前端 JS 编排，调工具得结果喂回 LLM        │
└──────────────────┬───────────────────────────────────────────┘
                   │ tool call (name + args)
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Tool Layer  (src/agent/tools/*.ts)                          │
│  ├─ get_current_document.ts                                   │
│  ├─ get_selection.ts                                          │
│  ├─ get_cursor_position.ts                                    │
│  ├─ get_visible_range.ts                                      │
│  ├─ propose_insert.ts                                         │
│  └─ propose_replace.ts                                        │
│  每个工具 = 纯函数 (state: EditorState, args) => T           │
│  + 一个 impure wrapper 注入 view                              │
└──────────────────┬───────────────────────────────────────────┘
                   │ getActiveView() / getActiveState()
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Bridge Layer  (src/stores/useEditorBridgeStore.ts)          │
│  Pinia store, 持有:                                           │
│  └─ viewGetter: () => EditorView | null  (由 App.vue 注入)    │
│  Actions:                                                     │
│  ├─ setActiveViewGetter(fn)                                   │
│  ├─ getActiveView(): EditorView | null                        │
│  ├─ getActiveState(): EditorState | null                      │
│  └─ getActiveTabId(): string | null  (从 tabsStore 读)        │
└──────────────────┬───────────────────────────────────────────┘
                   │ viewGetter()
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Existing Wrapper  (SourceEditor.vue / EditorPane.vue)        │
│  不动核心逻辑，仅在 onMounted/onBeforeUnmount 注册到 bridge    │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 为什么选 Pinia store 而非 provide/inject

| 维度 | provide/inject | Pinia store |
|---|---|---|
| 跨组件树访问 | 仅后代组件 | **任意位置**（包括非组件代码，如 agent 循环主体） |
| DevTools 可观测 | 弱 | **强**（Pinia devtools 显示 state/actions） |
| 单元测试 | 需挂组件树 | `setActiveStore(useEditorBridgeStore)` + 直接调 action |
| 与现有模式一致 | 项目 0 处使用 | 项目已用 5 个 store |

**结论**：Pinia store 是明显更优选择，与项目现有架构一致。

### 3.3 Active View 管理：单 view 模型

由于项目当前是「单 EditorPane 实例 + tab 切换覆盖文档」模型（见 §2.3 G2），bridge store 极简：

```typescript
// src/stores/useEditorBridgeStore.ts (草图)
import { defineStore } from "pinia";
import { ref } from "vue";
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { useTabsStore } from "./useTabsStore";

export const useEditorBridgeStore = defineStore("editorBridge", () => {
  const tabsStore = useTabsStore();
  // view getter 由 App.vue 在 onMounted 注入；null 表示编辑器未挂载（欢迎页）
  const viewGetter = ref<(() => EditorView | null) | null>(null);

  function setActiveViewGetter(fn: () => EditorView | null): void {
    viewGetter.value = fn;
  }
  function clearViewGetter(): void {
    viewGetter.value = null;
  }
  function getActiveView(): EditorView | null {
    return viewGetter.value?.() ?? null;
  }
  function getActiveState(): EditorState | null {
    return getActiveView()?.state ?? null;
  }
  function getActiveTabId(): string | null {
    return tabsStore.activeTabId;
  }
  return {
    viewGetter,
    setActiveViewGetter,
    clearViewGetter,
    getActiveView,
    getActiveState,
    getActiveTabId,
  };
});
```

**App.vue 改动（仅 3 行）**：

```typescript
import { useEditorBridgeStore } from "./stores/useEditorBridgeStore";
const bridge = useEditorBridgeStore();

onMounted(async () => {
  // ... 现有逻辑 ...
  bridge.setActiveViewGetter(() => editorRef.value?.getView() ?? null);
});
onBeforeUnmount(() => {
  bridge.clearViewGetter();
  // ... 现有逻辑 ...
});
```

> **未来多 view 演进路径**：若项目后续改为「每个 tab 一个独立 EditorView」（保留各自 undo 栈/选区），只需把 `viewGetter` 升级为 `Map<tabId, () => EditorView | null>`，`getActiveView()` 按 `tabsStore.activeTabId` 查表。工具层与 store 接口不变。

---

## 4. Per-Tool Implementation Notes

### 4.1 读类工具（纯函数 + impure wrapper）

每个工具拆为两层：**pure(state, args) → T** 便于单测，**impure wrapper** 从 bridge 取 state 调 pure 函数。

#### `get_current_document`

```typescript
// src/agent/tools/get_current_document.ts
import type { EditorState } from "@codemirror/state";

export interface GetCurrentDocumentResult {
  tabId: string | null;
  filePath: string | null;
  content: string;
  length: number;
  lineCount: number;
}

/** 纯函数：可独立单测 */
export function getCurrentDocumentPure(state: EditorState): Omit<GetCurrentDocumentResult, "tabId" | "filePath"> {
  const doc = state.doc;
  return {
    content: doc.toString(),
    length: doc.length,
    lineCount: doc.lines,
  };
}

/** impure wrapper：从 bridge 取 state，附加 tab 元数据 */
export function getCurrentDocument(bridge: ReturnType<typeof useEditorBridgeStore>): GetCurrentDocumentResult | { ok: false; error: string } {
  const view = bridge.getActiveView();
  if (!view) return { ok: false, error: "no_active_view" };
  const tabsStore = useTabsStore();
  const tab = tabsStore.activeTab;
  return {
    tabId: tab?.id ?? null,
    filePath: tab?.path ?? null,
    ...getCurrentDocumentPure(view.state),
  };
}
```

**性能（§5 题）**：`doc.toString()` 是 O(n) 一次切片，对 <1MB 文档（约 50k 行 Markdown）<5ms。**MVP 不分块**。若未来需要支持超大文档：

- 工具入参增 `startLine?` / `endLine?`，返回 `chunk_index` / `total_chunks`。
- LLM 通常不需要全文，`get_visible_range` + `get_selection` 已覆盖大多数场景。

#### `get_selection`

```typescript
export interface GetSelectionResult {
  ranges: Array<{ from: number; to: number; fromLine: number; toLine: number; text: string }>;
  main: number; // index into ranges
}

export function getSelectionPure(state: EditorState): GetSelectionResult {
  const sel = state.selection;
  const ranges = sel.ranges.map((r) => {
    const fromLine = state.doc.lineAt(r.from).number;
    const toLine = state.doc.lineAt(r.to).number;
    return {
      from: r.from,
      to: r.to,
      fromLine,
      toLine,
      text: state.sliceDoc(r.from, r.to),
    };
  });
  return { ranges, main: sel.mainIndex };
}
```

> 项目 `SourceEditor.vue` 已 `EditorState.allowMultipleSelections.of(true)`，所以 ranges 可能多个。

#### `get_cursor_position`

```typescript
export interface GetCursorPositionResult {
  head: number;
  anchor: number;
  line: number;  // 1-indexed
  ch: number;    // 0-indexed (与项目 cursor-change emit 口径一致)
}

export function getCursorPositionPure(state: EditorState): GetCursorPositionResult {
  const { head, anchor } = state.selection.main;
  const lineObj = state.doc.lineAt(head);
  return { head, anchor, line: lineObj.number, ch: head - lineObj.from };
}
```

> 已有 `SourceEditor.vue` 的 `cursor-change` emit 用同样公式，agent 工具与状态栏口径对齐。

#### `get_visible_range`

```typescript
export interface GetVisibleRangeResult {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  // 视口内文本（便于 LLM 看到用户当前所见）
  text: string;
}

export function getVisibleRangePure(state: EditorState, viewport: { from: number; to: number }): GetVisibleRangeResult {
  // 注意：纯函数版需调用方传 viewport，因为 viewport 来自 view 而非 state
  return {
    from: viewport.from,
    to: viewport.to,
    fromLine: state.doc.lineAt(viewport.from).number,
    toLine: state.doc.lineAt(viewport.to).number,
    text: state.sliceDoc(viewport.from, viewport.to),
  };
}

export function getVisibleRange(bridge: ReturnType<typeof useEditorBridgeStore>) {
  const view = bridge.getActiveView();
  if (!view) return { ok: false, error: "no_active_view" };
  return getVisibleRangePure(view.state, view.viewport);
}
```

**性能**：`view.viewport` 由 CM6 滚动时自动维护，是 O(1) 读取。`sliceDoc(from, to)` 仅切视口段，对大文档友好。**无需节流**——agent 工具是按需调用而非事件流。

### 4.2 写类工具（提议 → 接受/拒绝，StateField 模式）

**核心设计原则**：提议未接受前**完全不进 undo 栈**，仅以装饰形式可见；接受时 dispatch 真 transaction（默认 `addToHistory: true`），可被 Ctrl+Z 撤销。

#### StateEffect 定义

```typescript
// src/agent/proposal/proposalField.ts
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType } from "@codemirror/view";

export interface ProposedEdit {
  id: string;            // UUID，便于 accept/reject 定位
  type: "insert" | "replace";
  from: number;
  to: number;            // insert 时 from === to
  newText: string;
  oldText?: string;      // replace 时的原文快照（用于冲突检测）
  createdAt: number;
}

// Effects
export const proposeEditEffect = StateEffect.define<ProposedEdit>();
export const acceptProposalEffect = StateEffect.define<{ id: string }>();
export const rejectProposalEffect = StateEffect.define<{ id: string }>();
export const clearStaleProposalsEffect = StateEffect.define<void>();
```

#### StateField 定义

```typescript
export const proposalField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(proposals, tr) {
    // 1. 处理 effects
    for (const e of tr.effects) {
      if (e.is(proposeEditEffect)) {
        proposals = proposals.update({
          add: [buildProposalDecoration(e.value)],
        });
        // 同时把 ProposedEdit 元数据存到额外 StateField（见下）
      } else if (e.is(rejectProposalEffect)) {
        proposals = proposals.update({
          filter: (from, _to, value) => value.spec.id !== e.value.id,
        });
      } else if (e.is(acceptProposalEffect)) {
        // 接受：先从装饰集合移除，再 dispatch 真文本变更
        proposals = proposals.update({
          filter: (from, _to, value) => value.spec.id !== e.value.id,
        });
        // 真 transaction 由 acceptProposal() action 发起（见下）
      }
    }
    // 2. 文档变更时检测冲突：若 proposal 的 from/to 范围被改动，自动剔除
    if (tr.docChanged) {
      proposals = proposals.update({
        filter: (from, to, value) => {
          const edit = value.spec.proposedEdit as ProposedEdit | undefined;
          if (!edit) return true;
          // 检查 [edit.from, edit.to] 是否与任何 tr.changes 范围相交
          const hasConflict = tr.changes.iterChanges((cf, ct) => {
            return rangesIntersect(edit.from, edit.to, cf, ct);
          });
          if (hasConflict) {
            // 触发回调通知 UI「提议已过期」（实现细节：用 tr.effects 注入 staleNotification）
          }
          return !hasConflict;
        },
      });
    }
    return proposals;
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

#### 接受提议（dispatch 真 transaction）

```typescript
export function acceptProposal(view: EditorView, proposalId: string): void {
  const state = view.state;
  // 从元数据 StateField 查找 proposal
  const proposal = getProposalById(state, proposalId);
  if (!proposal) return;
  // 先移除装饰
  view.dispatch({ effects: acceptProposalEffect.of({ id: proposalId }) });
  // 再 dispatch 真文本变更（默认 addToHistory: true → 进 undo 栈）
  view.dispatch({
    changes: { from: proposal.from, to: proposal.to, insert: proposal.newText },
    // 可选：标记 annotation 便于未来「按 agent 分组撤销」
    // annotations: Transaction.addToHistory.of(true),
  });
}
```

#### 拒绝提议

```typescript
export function rejectProposal(view: EditorView, proposalId: string): void {
  view.dispatch({ effects: rejectProposalEffect.of({ id: proposalId }) });
}
```

#### 提议插入/替换（agent 工具入口）

```typescript
export function proposeInsert(view: EditorView, at: number, text: string): string {
  const id = crypto.randomUUID();
  view.dispatch({ effects: proposeEditEffect.of({
    id, type: "insert", from: at, to: at, newText: text, createdAt: Date.now()
  })});
  return id;
}

export function proposeReplace(view: EditorView, from: number, to: number, newText: string): string {
  const oldText = view.state.sliceDoc(from, to);
  const id = crypto.randomUUID();
  view.dispatch({ effects: proposeEditEffect.of({
    id, type: "replace", from, to, newText, oldText, createdAt: Date.now()
  })});
  return id;
}
```

> **关键点**：`view.dispatch({ effects: ... })` 中没有 `changes` 字段 → 文档不变 → **不进 history**。这是 CM6 的语义保证：history 仅记录 `docChanged` 的事务。StateEffect/StateField 的更新是「state 的一部分」但不入 history 栈。

---

## 5. Undo Stack 交互（CRITICAL）

### 5.1 CM6 History 语义确认

| 操作 | 是否进 undo 栈 | 原因 |
|---|---|---|
| `view.dispatch({ changes: {...} })` | **是** | `docChanged = true`，默认 `addToHistory: true` |
| `view.dispatch({ changes: {...}, annotations: Transaction.addToHistory.of(false) })` | **否** | 显式排除 |
| `view.dispatch({ effects: someEffect.of(...) })` | **否** | `docChanged = false`，effect 仅改 StateField，不入 history |
| `view.dispatch({ selection: {...} })` | **否** | `docChanged = false`，仅选区变更（注意：会进 `history()` 的 selection history，与文档 undo 栈独立） |
| `view.dispatch({ effects: proposeEditEffect.of(...) })` | **否** | 同上，effect only |

来源：CM6 官方文档 `Transaction.addToHistory` 注解 + `history()` 扩展行为。`@codemirror/commands` 6.x 的 `history()` 扩展仅追踪 `tr.docChanged && tr.annotation(Transaction.addToHistory) !== false` 的事务。

### 5.2 与项目硬约束的对齐

项目硬约束（来自 AGENTS.md / CONTEXT.md）：
- **Ctrl+Z/Y 仅限编辑器内容**：文件操作（保存、外部修改重载）不进 undo 栈。现有 `SourceEditor.vue` 的 `isApplyingExternalValue` flag 即为此设计——外部值同步走 `dispatch({ changes })` 但通过 flag 抑制 `update:modelValue` 回传，**并未显式 `addToHistory: false`**。这是一个**潜在 bug**：切 tab/外部重载时，旧文档内容会被推入 undo 栈，用户切回后按 Ctrl+Z 可能撤销到「上一个 tab 的内容覆盖」操作。**建议在 agent 工具落地时一并修复**：所有 `isApplyingExternalValue` 路径加 `annotations: Transaction.addToHistory.of(false)`。

### 5.3 Agent 提议的 undo 行为

| 阶段 | undo 栈状态 | Ctrl+Z 行为 |
|---|---|---|
| propose_insert/replace 后（未接受） | **空**（effect 不入栈） | 撤销上一个用户编辑，提议装饰不受影响（除非文档变更导致冲突，StateField 自动剔除） |
| accept 后 | **+1 entry**（真文本变更） | 撤销提议的文本变更，装饰也已移除 |
| reject 后 | **空** | 无变化 |

**完全符合** T5 推荐答案「接受后进 undo 栈，未接受不进栈」。

### 5.4 冲突处理（T5 sub-question 4）

StateField 的 `update` 方法在 `tr.docChanged` 时检查每个 proposal 的 `[from, to]` 是否与变更范围相交：

- **相交** → 自动剔除该 proposal 的装饰，可选触发 `onStaleCallback` 通知 UI「文档已变更，提议 #X 已过期」。
- **不相交** → 保留，但需 `proposals.map` 调整 from/to（CM6 的 `DecorationSet.map` 方法自动处理，调用 `proposals.map(tr.changes)`）。

```typescript
update(proposals, tr) {
  // ... effect 处理 ...
  if (tr.docChanged) {
    // 先 map（自动调整 from/to）
    proposals = proposals.map(tr.changes);
    // 再 filter 冲突的（map 后范围仍可能被部分覆盖）
    proposals = proposals.update({
      filter: (from, to, value) => !isOverlappingWithChanges(tr, from, to),
    });
  }
  return proposals;
}
```

---

## 6. Multi-Tab Active View 管理

### 6.1 现有模型：单 View + 文档覆盖

项目当前架构（`SourceEditor.vue` + `App.vue`）的关键事实：

- **同时只有一个 EditorView 实例**（`EditorPane` 用 `v-else` 渲染，欢迎页时根本不挂载）。
- **切换 tab 不销毁 view**：`activeContent` computed 的 setter 调 `tabsStore.updateContent()`，触发 `SourceEditor.vue` 的 `watch(() => props.modelValue)` → `view.dispatch({ changes: { from: 0, to: current.length, insert: next } })`。
- **切 tab 后 undo 栈不重置**：用户切走再切回，Ctrl+Z 会撤销「上一个 tab 的内容覆盖」操作（见 §5.2 潜在 bug）。

### 6.2 Agent 工具的约束

基于现有模型，agent 工具约定：

1. **仅在活跃 tab 上提议**：`propose_insert/replace` 通过 `bridge.getActiveView()` 拿到的就是当前 tab 的 view，无需「按 tabId 路由」。
2. **提议生命周期 < 一次 tab 切换**：tab 切换会 `dispatch({ changes: 全文替换 })`，StateField 的 `update` 会判定所有 proposal 与变更范围相交 → 自动清空。这是**期望行为**：用户切走意味着上下文已变，未接受的提议应失效。
3. **多 tab 多 view 演进路径**（若未来需要）：bridge store 升级为 `Map<tabId, EditorView>`，`EditorPane` 改为 `KeepAlive` 多实例，每个 view 独立 undo 栈。工具接口不变。

### 6.3 工具响应中携带 tab 元数据

每个工具返回结果都附 `tabId` + `filePath`，让 LLM 知道当前操作的目标：

```typescript
{
  "tabId": "tab-1722076800000-abc123",
  "filePath": "C:\\workspace\\notes\\2026-07.md",
  "content": "...",
  ...
}
```

---

## 7. Testing Strategy

### 7.1 纯函数测试（无 DOM）

读类工具的 pure 函数直接接 `EditorState`，零依赖：

```typescript
// src/agent/tools/get_current_document.test.ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { getCurrentDocumentPure } from "./get_current_document";

describe("getCurrentDocumentPure", () => {
  it("返回全文与行数", () => {
    const state = EditorState.create({ doc: "line1\nline2\nline3" });
    const result = getCurrentDocumentPure(state);
    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.lineCount).toBe(3);
    expect(result.length).toBe(17);
  });

  it("空文档", () => {
    const state = EditorState.create({ doc: "" });
    const result = getCurrentDocumentPure(state);
    expect(result.content).toBe("");
    expect(result.lineCount).toBe(1); // CM6 空文档算 1 行
  });
});
```

### 7.2 StateField 测试（无 DOM）

StateField 的 `update` 函数可独立测试，构造合成 transaction：

```typescript
import { StateEffect, StateField, Transaction, EditorState } from "@codemirror/state";
import { proposalField, proposeEditEffect, acceptProposalEffect } from "./proposalField";

function setupState() {
  return EditorState.create({
    doc: "hello world",
    extensions: [proposalField],
  });
}

describe("proposalField", () => {
  it("propose 后装饰存在；accept 后装饰移除且文档更新", () => {
    let state = setupState();
    state = state.update({ effects: proposeEditEffect.of({
      id: "p1", type: "insert", from: 5, to: 5, newText: " beautiful", createdAt: 0
    })}).state;
    
    let decos = state.field(proposalField);
    expect(decos.size).toBe(1);
    
    state = state.update({ effects: acceptProposalEffect.of({ id: "p1" })}).state;
    decos = state.field(proposalField);
    expect(decos.size).toBe(0);
    // 注意：accept 后的真文本变更需另 dispatch（见 §4.2 acceptProposal）
    // 此处仅验证装饰移除
  });

  it("文档变更与提议范围冲突时自动剔除", () => {
    let state = setupState();
    state = state.update({ effects: proposeEditEffect.of({
      id: "p1", type: "replace", from: 0, to: 5, newText: "HI", oldText: "hello", createdAt: 0
    })}).state;
    expect(state.field(proposalField).size).toBe(1);
    
    // 用户在 [0,5] 范围内手动改动
    state = state.update({ changes: { from: 0, to: 3, insert: "BYE" }}).state;
    expect(state.field(proposalField).size).toBe(0); // 自动剔除
  });
});
```

### 7.3 Impure wrapper 测试（jsdom + Pinia）

需要 view 实例时，复用项目已有的 `createTestView` 模式：

```typescript
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SourceEditor from "@/components/SourceEditor.vue";
import { useEditorBridgeStore } from "@/stores/useEditorBridgeStore";

describe("bridge integration", () => {
  beforeEach(() => setActivePinia(createPinia()));
  
  it("bridge.getActiveView() 返回 SourceEditor 的 view", async () => {
    const wrapper = mount(SourceEditor, { props: { modelValue: "test" }});
    const bridge = useEditorBridgeStore();
    bridge.setActiveViewGetter(() => wrapper.vm.getView());
    const view = bridge.getActiveView();
    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toBe("test");
  });
});
```

> 项目 `vitest.config.ts` 已配 `environment: "jsdom"` + `globals: true`，现有 `useEditorCommands.test.ts` 即用此模式。

### 7.4 E2E（Tauri WebDriver）

`window.__editorRef__` 已暴露，E2E 测试可直接：

```typescript
const view = await browser.execute(() => (window as any).__editorRef__?.getView());
const doc = await browser.execute(() => 
  (window as any).__editorRef__?.getView()?.state.doc.toString()
);
```

---

## 8. Code Sketches

### 8.1 完整工具注册示例（OpenAI function-calling 风格）

```typescript
// src/agent/tools/index.ts
import type { EditorView } from "@codemirror/view";
import { useEditorBridgeStore } from "@/stores/useEditorBridgeStore";
import { getCurrentDocument, GetCurrentDocumentResult } from "./get_current_document";
import { getSelection } from "./get_selection";
import { getCursorPosition } from "./get_cursor_position";
import { getVisibleRange } from "./get_visible_range";
import { proposeInsert, proposeReplace } from "./proposal";

export interface ToolContext {
  bridge: ReturnType<typeof useEditorBridgeStore>;
}

export const editorTools = [
  {
    name: "get_current_document",
    description: "Get the full content of the currently active markdown document.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (ctx: ToolContext) => getCurrentDocument(ctx.bridge),
  },
  {
    name: "get_selection",
    description: "Get the current text selection(s) in the active editor.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (ctx: ToolContext) => getSelection(ctx.bridge),
  },
  {
    name: "get_cursor_position",
    description: "Get the cursor position (line, ch) in the active editor.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (ctx: ToolContext) => getCursorPosition(ctx.bridge),
  },
  {
    name: "get_visible_range",
    description: "Get the currently visible text range in the editor viewport.",
    parameters: { type: "object", properties: {}, required: [] },
    run: (ctx: ToolContext) => getVisibleRange(ctx.bridge),
  },
  {
    name: "propose_insert",
    description: "Propose inserting text at a position. Shows a diff decoration; user accepts/rejects. Does NOT modify the document until accepted.",
    parameters: {
      type: "object",
      properties: {
        at: { type: "number", description: "Character offset (0-indexed) to insert at" },
        text: { type: "string", description: "Text to insert" },
      },
      required: ["at", "text"],
    },
    run: (ctx: ToolContext, args: { at: number; text: string }) => {
      const view = ctx.bridge.getActiveView();
      if (!view) return { ok: false, error: "no_active_view" };
      const id = proposeInsert(view, args.at, args.text);
      return { ok: true, proposalId: id };
    },
  },
  {
    name: "propose_replace",
    description: "Propose replacing a text range. Shows a diff decoration; user accepts/rejects. Does NOT modify the document until accepted.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "number" },
        to: { type: "number" },
        newText: { type: "string" },
      },
      required: ["from", "to", "newText"],
    },
    run: (ctx: ToolContext, args: { from: number; to: number; newText: string }) => {
      const view = ctx.bridge.getActiveView();
      if (!view) return { ok: false, error: "no_active_view" };
      const id = proposeReplace(view, args.from, args.to, args.newText);
      return { ok: true, proposalId: id };
    },
  },
] as const;
```

### 8.2 注册 proposalField 到 SourceEditor

```typescript
// src/components/SourceEditor.vue 中的 buildExtensions() 增加：
import { proposalField } from "../agent/proposal/proposalField";

function buildExtensions() {
  return [
    // ... 现有 extensions ...
    proposalField,  // ← 新增：agent 提议装饰
  ];
}
```

> 注意：`proposalField` 通过 `provide: (f) => EditorView.decorations.from(f)` 自动接入 CM6 装饰系统，与现有 `lineNumbers` / `highlightActiveLine` / `oneDark` 共存。CM6 装饰系统支持多源叠加，无冲突。

### 8.3 接受/拒绝按钮（T5 UI 占位）

按钮 UI 由 T5 prototype 决定，但其 click handler 调用：

```typescript
import { acceptProposal, rejectProposal } from "@/agent/proposal/proposalField";

// 在 Vue 组件中（按钮由 WidgetDecoration 渲染，点击事件经 dispatch 转发）
function onAcceptClick(proposalId: string) {
  const view = bridge.getActiveView();
  if (view) acceptProposal(view, proposalId);
}
function onRejectClick(proposalId: string) {
  const view = bridge.getActiveView();
  if (view) rejectProposal(view, proposalId);
}
```

---

## 9. References

### 9.1 项目内文件

- `src/components/SourceEditor.vue` — CM6 EditorView 宿主，`defineExpose({ getView })`
- `src/components/EditorPane.vue` — 转发 `getView()`，分屏容器
- `src/App.vue` — `editorRef` 持有 + `window.__editorRef__` E2E 注入 + 12 处 `editorRef.value?.getView()` 调用
- `src/composables/useEditorCommands.ts` — 段落格式化命令 + 测试辅助 `createTestView`
- `src/composables/useEditorCommands.test.ts` — vitest + jsdom 测试模式参考
- `src/composables/useImagePaste.ts` — `getEditorView` 回调注入模式参考
- `src/composables/useScrollSync.ts` — `editorView` 回调注入 + `lineBlockAtHeight` 视口查询
- `src/stores/useTabsStore.ts` — `activeTabId` / `activeTab` / `updateContent`
- `vitest.config.ts` — `environment: "jsdom"` + `globals: true`
- `CONTEXT.md` — 编辑器配置（行号/软折行默认）、Ctrl+Z 仅限编辑器内容
- `docs/adr/0001-draft-recovery-with-mtime-conflict-resolution.md` — `isApplyingExternalValue` flag 的来由

### 9.2 CodeMirror 6 文档与版本

- 项目使用版本（`package.json`）：
  - `@codemirror/state@^6.7.1`
  - `@codemirror/view@^6.43.6`
  - `@codemirror/commands@^6.10.4`（含 `history()` / `historyKeymap`）
  - `@codemirror/lang-markdown@^6.5.1`
  - `@codemirror/language@^6.12.4`
- CM6 官方文档：
  - [StateField](https://codemirror.net/docs/ref/#state.StateField)
  - [StateEffect](https://codemirror.net/docs/ref/#state.StateEffect)
  - [Decoration](https://codemirror.net/docs/ref/#view.Decoration)
  - [Transaction.addToHistory](https://codemirror.net/docs/ref/#state.Transaction.addToHistory)
  - [EditorView.viewport](https://codemirror.net/docs/ref/#view.EditorView.viewport)
  - [history() extension](https://codemirror.net/docs/ref/#commands.history)
  - [Testing CM6 guide](https://codemirror.net/docs/guide/#testing)

### 9.3 相关 Wayfinder Tickets

- [R2 本调研](https://github.com/CatInRl/Murasaki/issues/10)
- [R3 CM6 diff 装饰方案](https://github.com/CatInRl/Murasaki/issues/11) — 与本报告 §4.2 / §5 互补，R3 聚焦装饰细节，本报告聚焦工具桥接
- [T1 循环架构](https://github.com/CatInRl/Murasaki/issues/2) — 工具在前端 JS 编排
- [T5 提议 UI](https://github.com/CatInRl/Murasaki/issues/7) — 接受/拒绝按钮形态
