# ADR 0022: 编辑会话作为当前文档的唯一真相

## 状态

已接受

## 背景

当前「当前文档」的状态被切成四份，分别由不同模块持有：

- 标签页 `Tab` 持有 `content`、`savedContent`、`lastMtime`、`isDirty`、`hasExternalChange`；
- CodeMirror 的 `EditorView` 持有文档与撤销历史；
- `SourceEditor.vue` 的 `stateCache` 按 tab 缓存 `EditorState`（含撤销栈），**从不按 tab 淘汰**；
- `useEditorBridgeStore` 另存 `activeDocPath` 与 `editorView`，但应用代码从不读取。

由此产生三类问题：

1. **脏态有 4 套判据**：内容比较（`useTabsStore.ts:350`）、草稿 mtime（`:107-111`）、`initialContent.length > 0`（`:149-153`）、`keep-local` 无条件置真（`:255-258`）。只有第一套与「未保存」的语义一致。
2. **草稿规则重复**：`dirty && path → saveDraft(..., lastMtime ?? 0)` 在 `useTabsStore.doCloseTab` 与 `useExitFlush` 各写一遍；mtime 对齐规则在 3 处注释与实现中重复。
3. **顺序约束外露**：切标签必须 `view.setState()` 后再 `reconfigure` WYSIWYG / 字体 / 快捷键三个 compartment；外部同步必须带 `addToHistory.of(false)`；这些只写在注释里，调用方无从得知。

同时，`Tab.cursor` / `Tab.scroll` 运行时不更新，持久化写入的永远是初始值；`hasExternalChange`、`editorView`、`activeDocPath` 在应用代码中读取次数为 0。

## 决策

引入**编辑会话（Editor Session）**：每个标签页一份，作为当前文档的唯一真相。

1. **所有权**：会话持有缓冲区、脏态、磁盘基线（内容 + mtime）、草稿与撤销历史；标签页只保留身份、顺序与激活态。
2. **脏态单一定义**：`isDirty = content !== baselineContent`，不再有第二套判据。草稿恢复后内容与磁盘不同 → 自然为脏；撤销回原内容 → 自然不脏。
3. **草稿归会话**：草稿读写与冲突判定不再散落在关闭、退出、外部修改三条链路里。
4. **冲突裁决外置**：会话不做 UI 决定，返回类型化冲突结果；界面让用户选择「磁盘版 / 草稿版」后回传。
5. **两个 seam**：`EditorAdapter`（CodeMirror：负责换入状态后重新应用当前模式与光标监听，具体 compartment 由宿主注入）与 `DocumentStore`（整文件读写、mtime、草稿）。两者都有内存假实现，测试不需要 mock `invoke`。
6. **草稿自动写入**：脏会话在内容变更后约 2 秒写草稿，关闭与退出强制 flush。它不等于保存到文件。
7. **分三阶段落地**：Phase 1 纯增量引入模块与 seam；Phase 2 写路径接入、`Tab.content` 改为派生；Phase 3 迁移读点、删除旧字段与死状态。

## 理由

- **Locality**：脏态、草稿、mtime 基线这三条最易造成数据丢失的规则，从 3 个模块收敛到 1 个。
- **Leverage**：编辑、保存、关闭、退出、外部修改五条链路共用同一组命令，不再各自维护快照字段。
- **测试面**：冲突矩阵、草稿恢复、关闭策略可以在会话接口上用假 adapter 表驱动，不必依赖真实 WebView2 的时序。

## 备选方案

- **原地加深 `useTabsStore`**：改动最小，但会把持久化、窗口生命周期与编辑状态继续挤在同一个 store 里，`App.vue` 的耦合不会下降。
- **双写过渡**：新旧字段同时维护一段时间。被否决——本次要消灭的正是「同一事实多份真相」，双写会把它制度化。
- **只把 `stateCache` 换成 LRU**：能缓解内存增长，但脏态与草稿的重复判定仍然存在。

## 后果

- `Tab.content` / `Tab.savedContent` / `Tab.hasExternalChange` / `Tab.isDirty` 最终移除；读取方改用会话快照。
- `SourceEditor` 不再持有 `stateCache`；切标签时由会话通过 `EditorAdapter` 换入编辑状态。
- 关闭标签即释放会话，撤销历史随文档关闭而回收。
- `Tab.cursor` / `Tab.scroll` 从「初始值占位」变为真实接线，跨重启可恢复光标与滚动位置。
- 草稿目录的写入频率上升（每脏文档约 2 秒一次），但单次写入的是小文本，且保存成功即删除。

## 实施边界

- 不引入第二套文档模型；仍然只有一个 CodeMirror `EditorView`（见 ADR-0008）。
- 草稿的 `knownMtime` 必须与磁盘基线对齐（见 ADR-0001）。
- 多窗口仍按 WebView 隔离，每个窗口各自持有自己的会话集合（见 ADR-0018）。
- 草稿自动写入不改变用户文件，不引入「自动保存到文件」语义。
