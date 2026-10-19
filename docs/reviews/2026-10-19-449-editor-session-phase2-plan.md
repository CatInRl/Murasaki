# #449 EditorSession Phase 2 迁移计划（2026-10-19）

> 依据 handoff `murasaki-handoff-2026-10-19.md` 第 4.2 节与 ADR-0022 编写。
> 目标：写路径接入 `editorSession`，`Tab.content` 改为派生 getter，删除 `savedContent`，
> 落地草稿 2s 防抖自动写入。Phase 3（#450）不在本计划内。

## 一、现状盘点（写计划时实测）

### 1.1 已有模块（Phase 1，#448 已合入）

| 文件 | 内容 |
|---|---|
| `src/editor/session/types.ts` | `EditorSession` / `DocumentStore` / `EditorAdapter` / `SessionSnapshot` / `OpenResult` / `SaveResult` / `DisposeOptions` |
| `src/editor/session/editorSession.ts` | `openEditorSession()`：脏态单判据 `content !== baselineContent`、2s 防抖草稿、`save` / `saveAs` / `resolveConflict` / `flushDraft` / `attachEditor` / `detachEditor` / `dispose({draft})` |
| `src/editor/session/documentStore.ts` | 生产实现：接 `fileSystem` + `get_file_mtime` |
| `src/editor/session/editorAdapter.ts` | CodeMirror 实现：`setState` 后自动 `applyMode` + 重注入 selection 监听 |
| `src/editor/session/editorSession.test.ts` | 19 条单测（打开/冲突/防抖/保存/seam） |

### 1.2 `useTabsStore` 的 10 个写方法（#449 范围）

| 方法 | 当前写字段 | 迁移后 |
|---|---|---|
| `openFile` | `content` `savedContent` `lastMtime` `isDirty` `hasExternalChange` | `openEditorSession()` + 按 `OpenResult` 分流 |
| `newTab` | 同上（`savedContent=""`） | `openEditorSession({path:null, initialContent})` |
| `updateContent` | `content` `isDirty` | `session.setContent()` |
| `saveTab` | `savedContent` `isDirty` `lastMtime` + deleteDraft | `session.save()` |
| `saveTabAs` | `path` `savedContent` `isDirty` `lastMtime` | `session.saveAs()` + `tab.path = result.path` |
| `doCloseTab` | deleteDraft / persistDraftQuietly | `session.dispose({draft: keep\|discard})` |
| `reloadFromDisk` | `content` `savedContent` `isDirty` `lastMtime` + 草稿兜底 | 草稿防抖天然覆盖；仅重设基线 |
| `writeMergedContent` | `content` `savedContent` `isDirty` `lastMtime` | 走 `session.setContent` + `save` |
| `applyExternalResolution` | `content` `savedContent` `isDirty` `lastMtime` `hasExternalChange` | load-disk → 重设基线；keep-local → 对齐 mtime |
| `syncPathsAfterMove` | `path` + 草稿迁移 | `tab.path` 改 + 旧键草稿清理（session 侧 `currentPath` 同步） |

### 1.3 其他写草稿的链路

- `useExitFlush.flushUnsavedOnExit`：退出时对每个 dirty tab `saveDraft` → 改为 `session.flushDraft()`；`writeDrafts:false` 分支 → `dispose({draft:"discard"})`。
- `useTabClose`：只通过 `doCloseTab(id,{keepDraft})` 间接触达，**不改签名**（兼容现有单测）。

### 1.4 读点（Phase 3 处理，但 Phase 2 必须保证不破坏）

`App.vue` `activeContent` computed、`useFileActions`（export HTML/PDF、reload）、`useCopyRichText`、`useCompareWindow`（`localContent`）、`useExitFlush`、`TabBar`、`StatusBar`、`tabList.ts`、`searchLogic`（jump line）。
Phase 2 的做法：`Tab.content` 保留为 **getter**（定义在 `types.ts` 之外，由 store 的 `activeTab` computed 提供），读点无需改动即可继续工作。

## 二、设计决策

### D1 `Tab` 的字段形态

`Tab` 从「数据接口」改为「身份 + 派生视图」：

```ts
interface Tab {
  id: string;
  path: string | null;          // 身份，可写（rename/move）
  cursor: CursorPosition;       // 占位，Phase 3 真正接线
  scroll: ScrollPosition;
  // 以下为 store 通过 session 快照填充的派生字段（getter / 每次渲染重算）
  readonly content: string;
  readonly isDirty: boolean;
  readonly lastMtime: number | null;
}
```

- 不在 `Tab` 上挂 getter（Pinia/reactive 对象上的 getter 语义脆弱），而是由 `activeTab` / `getTabByPath` 返回时**浅拷贝派生字段**。切 tab 与内容变化都会让 computed 重算，读点拿到的始终是新值。
- `savedContent`、`hasExternalChange` **Phase 2 即删除**（#449 验收标准明确要求删 `savedContent`）。

### D2 session 容器

`useTabsStore` 内持有 `Map<tabId, EditorSession>`（模块级私有，不暴露）。

- `openFile` / `newTab` 时创建；`doCloseTab` / `clearAll` 时 `dispose`。
- `restore()` 期间按持久化顺序创建，`activate:false` 语义保留。

### D3 冲突裁决接线（#425 复用现有 UI）

`openFile` 拿到 `OpenResult.kind === "conflict"` 时，调现有 `draftConflictResolver`（App.vue 已注入），把 `ConflictInfo` 映射为 `DraftConflictInfo`，用户选择后 `session.resolveConflict(choice)`：

| 用户选择 | session 调用 |
|---|---|
| 保留草稿 | `resolveConflict("draft")` |
| 加载磁盘 | `resolveConflict("disk")` |
| 稍后处理 | 不调用（`pendingConflict` 保留，tab 以磁盘内容打开） |

`draftConflictResolver` 的「未注入」分支保持现状（用磁盘内容打开、草稿保留）。

### D4 草稿兜底（#378 / #424 / #426 全部保持）

现有语义「覆盖 / 重载前先写草稿」由 session 的 2s 防抖 + `flushDraft()` 天然覆盖：

| 场景 | 旧实现 | 新实现 |
|---|---|---|
| 关闭 dirty tab | `persistDraftQuietly(path, content, lastMtime)` | `dispose()` 默认 `flushDraft()` |
| 关闭选「不保存」 | `doCloseTab(keepDraft:false)` 删草稿 | `dispose({draft:"discard"})` |
| load-disk 覆盖 | 覆盖前 `persistDraftQuietly` | 脏会话本就有草稿；不额外写 |
| reload 前兜底（#424） | `persistDraftQuietly(lastMtime)` | 同上 |
| keep-local | 对齐 `lastMtime` | `session` 重设 `baselineMtime`（新增 `rebaseline(mtime)` 或复用 save 语义，见下） |

**注意**：session 当前没有「只重设 mtime 基线、不改内容」的接口。`applyExternalResolution("keep-local")` 与 `reloadFromDisk` 的草稿兜底都依赖它。两条路：
- (a) 给 session 加 `rebaseline(mtime: number)`：只改 `baselineMtime`，不动内容/脏态。语义清晰、改动小。
- (b) 复用 `save()`：会把内容写回磁盘 —— 语义错误，否决。

选 (a)。这属于 Phase 2 对 session 接口的**最小扩展**，需同步补单测。

### D5 `writeMergedContent`

对比窗口「保存合并结果」= 写盘 + 更新基线。直接 `session.setContent(merged)` + `session.save()` 两次调用即可，不需要新接口。`externalContent` 传入的 load-disk 同理：`setContent` + `rebaseline`。

### D6 撤销历史

Phase 2 **不动** `SourceEditor.stateCache`（Phase 3 才删）。session 的 `attachEditor/detachEditor` 在 Phase 2 不接线到 SourceEditor，只保留模块能力。理由：切 tab undo 隔离是高风险行为，与写路径迁移解耦，出问题时可二分定位。

### D7 持久化（tabs.json）

`persist()` 仍读 `tab.content`（getter）。session 的 `onChange` 回调里调 `schedulePersist()`，替代现在 watcher 依赖的 `tabs` 深监听中 content 变化那一部分。**保留现有 watcher**（tabs 数组增删 / activeTabId 变化仍需它），双保险不冲突（`schedulePersist` 本身有 Timer 去重）。

## 三、实施步骤（按序，每步可独立验证）

| # | 步骤 | 涉及文件 | 验证 |
|---|---|---|---|
| 1 | session 加 `rebaseline(mtime)` + 单测 | `session/types.ts` `editorSession.ts` `editorSession.test.ts` | `npm test` |
| 2 | `Tab` 类型瘦身：删 `savedContent` / `hasExternalChange`，`content` / `isDirty` / `lastMtime` 改只读派生；新增 `EditorSessionMap` 容器类型 | `types.ts` | `npm run build`（tsc 报出所有读点，逐个改） |
| 3 | store 内建 session 容器 + `activeTab`/`getTabByPath`/`tabs` 返回时填充派生字段 | `useTabsStore.ts` | 单测 |
| 4 | 迁移 `openFile`（含冲突裁决接线）/ `newTab` | 同上 | `useTabsStore.test.ts` 全绿 |
| 5 | 迁移 `updateContent` / `saveTab` / `saveTabAs` | 同上 | 同上 |
| 6 | 迁移 `doCloseTab`（`dispose`）/ `clearAll`（批量 dispose） | 同上 | 同上 + `useExitFlush.test.ts` |
| 7 | 迁移 `reloadFromDisk` / `writeMergedContent` / `applyExternalResolution` / `syncPathsAfterMove` | 同上 + `useCompareWindow.test.ts` | 同上 |
| 8 | `useExitFlush` 改调 `session.flushDraft()`（经 store 暴露 `flushAllDrafts()` / `discardAllDrafts()`） | `useExitFlush.ts` | `useExitFlush.test.ts` |
| 9 | 新增「草稿自动写入」单测（防抖触发 / 取消 / 落盘串行） | `useTabsStore.test.ts` 或新文件 | 覆盖率不低于基线 |
| 10 | `npm test` + `npm run build` + `npm run lint` + `npm run format:check` + `npm run typecheck:e2e` 全绿 | — | 门禁 |
| 11 | 本地 e2e（至少 editor / file-operations / tabs 相关 spec） | — | `npm run test:e2e` |
| 12 | code-review（Standards + Spec 双轴）→ 修完 → 开 PR → CI 全绿 → squash 合入 | — | 流程要求 |

## 四、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `activeTab` computed 浅拷贝派生字段后，某些读点依赖对象身份（`===`） | 难查的 UI 不刷新 | 步骤 3 后跑全量单测 + e2e；`watch(activeTab)` 类监听改为 `watch(() => activeTab.value?.id)` |
| session 创建是 async（`openEditorSession` 要读盘），`openFile` 已经是 async，无新增风险；但 `newTab` 从同步变异步 | 调用方需 await | 检索全部 `newTab(` 调用点；`onNewTab` 等入口本就 async |
| 退出路径 `flushUnsavedOnExit` 改为 async flush，3s 超时兜底仍生效 | 大文档草稿写超时 | 保持 `Promise.race` 不变；session 的 `flushDraft` 是串行链，最坏一次写 |
| 未命名 tab 的 `content` 来自 `tabs.json` 恢复（Phase 2 仍走 `newTab(initialContent)`） | 无变化 | 保留 `initialContent` 参数 |
| `restore()` 里逐个 `openFile` 现在是「读盘 + 建 session」，比原来多一次 `draftExists` | 启动略慢 | `documentStore` 的 `draftExists` 是 fs 元数据查询，可接受；e2e 的 `waitForAppReady` 判据不变 |

## 五、验收对照（#449）

- [ ] 所有写入口只经过 session，无双写 —— 步骤 3–8
- [ ] `Tab.content` / `Tab.isDirty` 为派生 getter —— D1
- [ ] 关闭时「不保存」不再写草稿（#426）—— 步骤 6，保留 `useTabsStore.test.ts` 既有断言
- [ ] 草稿冲突弹窗接上 UI（#425）—— D3，保留既有 4 条断言
- [ ] 现有单测与 e2e 全绿；新增草稿自动写入的测试 —— 步骤 9–11
