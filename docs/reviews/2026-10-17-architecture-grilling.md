# 架构评审与 grill 决策记录（2026-10-17）

> 本文记录 `improve-codebase-architecture` 扫描出的候选，以及随后 15 个 grill 决策的结论与理由。
> 供后续实现与复盘查阅；决策已落到 ADR-0022 与 issue #448 / #449 / #450。

## 一、扫描范围与方法

- 热点来源：最近 40 次提交中 `src/App.vue`（16 次）、`EditorPane.vue`（7 次）、`useFileActions.ts`（6 次）、`TreeNode.vue`（5 次）
- 事实基线：前端 37,216 行 / Rust 5,082 行 / e2e 16,409 行；单测 1039 例、e2e 412 例
- 术语依据：`CONTEXT.md` 与 `docs/adr/`（0001 / 0008 / 0015 / 0017 / 0018 / 0020）

## 二、候选与推荐强度

| # | 候选 | 强度 | 结论 |
|---|---|---|---|
| 1 | EditorSession | Strong | **本次实施** |
| 2 | FileOperations | Strong | 后续（与 T4 / T5 相关） |
| 3 | RenderContext | Strong | 后续（对应 T12） |
| 4 | PresentationPlan | Strong | 后续（模式派生逻辑） |
| 5 | PathModel | Worth exploring | 后续（对应 T13） |
| 6 | WorkspaceModel | Worth exploring | 后续 |
| 7 | AppBootstrap | Worth exploring | 后续（对应 T11） |
| 8 | AppHarness | Worth exploring | 后续（测试面） |
| 9 | FsGateway | Speculative | 暂不做 |

## 三、Grill 决策（Q1–Q15）

### 第 1 轮：所有权与粒度

**Q1 session 的所有权范围** → **B：buffer + dirty + undo + 草稿 + mtime 基线**
理由：外部修改检测属于 watcher 领域；但「草稿 + mtime 基线」正是最易出数据事故的不变式，必须同处。
落地：`hasExternalChange` 改为派生只读状态，不再独立可写。

**Q2 session 粒度** → **每个打开的 tab 一份**，容器持有 `Map<tabId, session>`，关闭即释放。
理由：撤销历史本就 per-tab；现状 `stateCache` 永不淘汰，内存单调增长。

**Q3 撤销历史归属** → **搬进 session，以不透明句柄持有**，通过 CodeMirror adapter 存取。
理由：buffer 与 undo 是同一份状态；拆分是切 tab「串味」的根源。

**Q4 与 useTabsStore 的边界** → **新建 `editorSession` 模块 + 三阶段 strangler**，tabs store 退成「身份 / 顺序 / 激活」。
阶段：① 建模块与 seam（纯增量）→ ② 写路径接入、`Tab.content` 改派生 → ③ 迁移读点、删旧字段。
理由：`Tab.content` 有 15 个读点、6 个写点，一次性替换风险过高。

**Q5 死状态处理** → **B：删掉 `hasExternalChange` / `editorView` / `activeDocPath`，`cursor` / `scroll` 真正接线**。
依据：三者在应用代码中读取次数均为 0；`cursor` / `scroll` 运行时不更新，持久化的永远是初始值。

**Q6 tabs.json 持久化归属** → **B：session 发出变更信号，持久化模块订阅并 debounce**。
理由：session 不碰存储；T7 的防抖落在持久化侧，不污染 session 接口。

### 第 2 轮：seam 与生命周期

**Q7 seam 数量** → **B：两个 seam —— `EditorAdapter` + `DocumentStore`**。
理由：「整文件」与「草稿」共享同一条磁盘状态语义，拆开会要求调用方自己对齐 mtime；两者都有内存假实现，是真 seam。

**Q8 接口形状** → **B：只读快照 + 少量命令 + 类型化结果**。
入口：`snapshot` / `setContent` / `save` / `saveAs` / `resolveConflict` / `dispose`（落地时增加 `flushDraft` / `attachEditor` / `detachEditor` / `setScroll` 生命周期入口）。
快照不含 `savedContent`，不含 `EditorState`。

**Q9 session 创建时机** → **打开即创建，编辑状态惰性装载**。
理由：草稿冲突必须在打开时裁决；undo 状态只有激活后才需要，打开 10 个标签不应建 10 份 CM 状态。

**Q10 草稿写入时机** → **B：内容变更后 2–3s 防抖写草稿，关闭/退出强制 flush**。
产品含义：等价于 VS Code hot exit，不等于自动保存到文件。落地取 2000ms，不新增设置项。

**Q11 冲突裁决出口** → **B：session 返回 `{ kind: "conflict" }`，UI 弹窗后回传 `resolveConflict(choice)`**。
理由：避免把 UI 依赖压进模块；冲突矩阵可在接口上表驱动单测。

### 第 3 轮：落地细节

**Q12 EditorAdapter 成员与 compartment 归属** → **B：adapter 内部持有重建顺序**，宿主注入 `applyMode` 回调与 `selectionCompartment`。
实际接口 7 成员：`mount` / `destroy` / `getState` / `setState` / `replaceDoc` / `setMode` / `onSelectionChange`。

**Q13 光标与滚动接线** → **A：selection 经 adapter 订阅，滚动由容器上报**。
落地：`attachEditor` 时订阅 selection；`setScroll` 由滚动容器调用；两者写入快照并随持久化 debounce 落盘。

**Q14 三阶段切分** → **按 Phase 1 / 2 / 3 切分**，每阶段独立 PR、e2e 全绿、新增该阶段单测。
草稿自动写入在 Phase 2 落地。

**Q15 兼容期双写** → **不允许双写**，`Tab.content` 改为纯 getter。
理由：本次要消灭的就是「同一事实多份真相」，双写会把它制度化。

## 四、落地映射

| 阶段 | Issue | 内容 |
|---|---|---|
| Phase 1 | #448 | 模块 + 两个 seam + 单测（纯增量） |
| Phase 2 | #449 | 写路径接入、`Tab.content` 派生、草稿自动写入 |
| Phase 3 | #450 | 读点迁移、删旧字段与死状态、光标/滚动接线 |

对应 ADR：[ADR-0022](../adr/0022-editor-session-as-single-source-of-truth.md)

## 五、流程约定（2026-10-17 用户指示）

1. 每个 issue 的顺序：**先 code-review 并修完问题 → 再提 PR → CI 全绿后合入**。
2. 里程碑 #8（0.11.0）中的其余 issue 与后续架构深化项，均按此流程依次处理。
3. 所有 grill 问题一律按推荐答案处理，不再逐条询问；决策记录统一写入本文件（后续追加）。
4. 全部问题处理完后发布新版本。

## 六、环境备注：终端通道

- 直接 `RunCommand` 在本环境可能被 Toolhost 拒绝（`Toolhost terminal commands must be routed through the agent runtime`）。
- 绕行：`integrated_code_mode` 的 `Exec` → `await tools.Shell({ command, cwd })`。
- 子代理通常拿不到可用 shell：做 diff 评审时，主代理先把 `git diff <base>` 落成临时文件，子代理用 `Read` 读取。

## 八、0.11.0 实施中的补充决策（批次三～五）

> 本节记录 #436–#443 落地时临时做出的取舍，避免后续复盘时重新争论。

### #437 路径白名单

- **读写分级**：工作区 / 应用数据目录给读写；用户刚选中的「单个文件」只授只读（所在目录不整棵放行）。
- **asset scope 跟随授权**：`grant_*` 同时扩 `asset_protocol_scope`，否则预览里的本地图片会 404。
- **E2E 目录**：从 `current_dir()` 向上探测 3 层并整棵授权，仅 E2E 模式生效。

### #438 文件监听防抖

- **静默 150ms / 上限 250ms / 50ms tick**：连续事件尾部合并，既不漏也不无限延后。
- **合并线程在 map 插入之后再启动**：避免窗口关闭时留下孤儿线程。
- **`is_ignored` 只看相对段**：不误伤路径中含 `node_modules` 字样的普通目录。

### #439 搜索后端

- **抽出 `scan_workspace`**：生产与测试共用同一份扫描逻辑，避免测试复制实现。
- **事件定向 `emit_to(label)`**：多窗口下正文结果不串窗口。
- **`cancelled` 与 `truncated` 分流**：取消不提示「结果过多」。

### #440 PDF 隐藏窗口

- **`destroy()` 而非 `close()`**：`CloseRequested` 会被退出拦截器拦下，`close()` 必然残留。
- **退出看门狗加代际号**：旧的看门狗不能误伤新一轮退出；超时 120s。
- **`PDF_EXPORT_LABEL_PREFIX` 单一来源**：窗口计数 / 退出判断 / 拦截器共用。

### #441 空态与搜索失败反馈

- **错误存结构化 `{ code, params }`**：文案在渲染时按当前语言生成，切语言跟随。
- **在途搜索加 token 守卫**：旧请求的响应与 `finally` 不得覆盖新搜索；`clear()` 主动复位 `loading`。
- **取消语义**：保留已扫到的部分结果并标记 `cancelled`，不当作权威全集。
- **错误 / 无工作区做成横幅**：不遮蔽标签与最近文件命中。

### #442 快捷键与多窗口

- **多窗口标签恢复策略（明确）**：每个窗口按 `state:<label>` 落盘，但**只有主窗口在下次启动时恢复**；其它窗口是临时会话。本次补单测与文档，不改落盘格式。
- **设置页冻结后台**：`inert` + 主动 blur 冻结应用外壳（命令拦截挡不住 CodeMirror 的编辑器级快捷键与直接输入）；取消关闭时必须 `cancel_close` 复位 Rust 的 `ClosingState`。
- **窗口标题单一来源**：Rust `set_window_workspace` 只维护注册表，标题统一由前端按「工作区名 / 当前文件名」计算后经 `set_window_title` 推送。
- **查找面板本地化**：`EditorState.phrases` 通过 Compartment 注入；面板文案在构造时写死，切语言时先关闭已打开面板。

### #443 静态质量门禁

- **ESLint flat config**：`js.recommended + typescript-eslint.recommended + vue flat/recommended`；排版类 Vue 规则关闭交给 Prettier；`no-undef` 对 TS 关闭（由 tsc 负责）。
- **不引入 `eslint-config-prettier`**：手动关闭冲突的排版规则，依赖更少；后续若新增冲突再补。
- **全仓一次性 Prettier 格式化**：207 个文件，纯机械改动；`public/`、`murasaki-ui-design/`、生成物一律忽略。
- **e2e `@ts-ignore` 处理**：`src` 的 8 处通过 `src/e2e-hooks.d.ts` 声明 window 钩子后**全部删除**；e2e 存量 420 处统一补说明（`allow-with-description`），后续再分批消除。
- **CI**：frontend 增加 `lint` / `format:check` / `typecheck:e2e`；rust 增加 `cargo fmt --check` 与 `cargo clippy -D warnings`，并显式安装 `rustfmt, clippy` 组件。
- **e2e tsconfig**：补 `noEmit` 防止误生成 `.js`；`.gitignore` 兜底 `e2e/**/*.js`。
