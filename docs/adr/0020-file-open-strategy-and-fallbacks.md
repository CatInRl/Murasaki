# ADR 0020: 各类型文件的打开策略与兜底出口

## 状态

已接受

## 背景

「哪些文件能打开、各自怎么打开」此前从未成文。判定本身是集中的（[fileKind.ts](../../src/utils/fileKind.ts)），但**打开行为**散在四处，各自为政：

- [TreeNode.vue](../../src/components/TreeNode.vue) 的 `onClick` / `buildMenuItems`（文件树点击与右键）
- [dropPlan.ts](../../src/utils/dropPlan.ts) 的 `planDrop`（拖入窗口）
- [useFileActions.ts](../../src/composables/useFileActions.ts) 的 `openFile`（打开失败如何收场）
- [App.vue](../../src/App.vue) 的 `effectiveEditorMode`（html 的显示模式降级）

0.7.0 / 0.7.1 为 HTML 引入了「源码 + 右侧沙箱 iframe」的预览（`HtmlPreview`），与 markdown 的渲染预览（`PreviewPane`）是**两套完全不同的实现**。issue #149 由此提出反思：`isDocumentFile = markdown || html` 这个「文档类」抽象是否成立？HTML 该不该强制预览？二进制/未知文件该不该有出路？四个入口里，最糟的一格是**应用打不开的文件**：文件树点击**没有任何反应**（旧代码 `if/else if` 之后没有分支），拖入窗口**静默丢弃**，用户唯一的出路是右键「在资源管理器中显示」再自己双击 —— 「点了没反应」比「明确说不支持」更糟。

#149 的讨论（含一次自我更正）得到两组结论：一组是**设计判断**（A/B/D），一组是**待补的缺口**（C）。后者已分别落地：#307（兜底出口）、#308（无后缀试读），拖入反馈由 #317 补上。本 ADR 把结论固化下来 —— 否则它们只活在 issue 评论里。

## 决策

### 1. 打开策略矩阵（现状 + 本次固化）

| 类型 | 判定 | 文件树点击 | 右键菜单 | 拖入窗口 | 显示模式 |
|---|---|---|---|---|---|
| Markdown | `isMarkdownFile` | 打开为标签 | 「打开」 | 打开为标签 | 源码 / 分屏 / 所见即所得 / 演示 |
| HTML | `isHtmlFile` | 打开为标签 | 「打开」 | 打开为标签 | 源码 / 分屏 / 演示（**只挡所见即所得**） |
| 图片 | `isImageFile` | 应用内轻量预览窗 | 「预览」 | 按插入方式插入编辑器（不打开标签） | — |
| 可编辑文本 / 代码 | `isEditableTextFile`（白名单） | 打开为标签 | 「打开」 | 打开为标签 | 强制源码 + 语言高亮 |
| 无后缀 | `isEditableTextFile`（一律允许**试读**） | 打开为标签（≥1MB 先确认） | 「打开」 | 打开为标签 | 强制源码 |
| **其余（pdf / docx / zip / exe / 白名单外后缀）** | 上述全为 `false` | toast「此文件无法在 Murasaki 中打开」+「用系统默认程序打开」 | 「用系统默认程序打开」 | 计数提示，**恰好 1 个**时附「用系统默认程序打开」 | — |

### 2. 「文档类」抽象保留，但它只决定「挂不挂预览面板」

`isDocumentFile`（= markdown ∨ html）的语义是 ①「要不要挂预览面板」，**不是** ②「预览意味着什么」—— markdown 是**渲染文档**，html 是**在沙箱里跑一个网页**，两条渲染路径（`PreviewPane` / `HtmlPreview`）本就独立。抽象因此成立，不需要拆；`isSourceOnlyFile`（非文档类）才是「强制源码」的判据。

### 3. HTML 只挡「所见即所得」，源码 / 分屏 / 演示都尊重用户选择

`effectiveEditorMode` 现在只在「请求 wysiwyg 且当前不是 markdown」时降级为 `split`，其余原样透传。这是合理的：html 没有 markdown 渲染，所见即所得无从谈起；但「看源码」「左边源码右边跑页面」都是合法诉求，不该被静默推翻。

### 4. 不为 `.vue` / `.jsx` / `.tsx` 提供沙箱预览

它们不是合法的 HTML（SFC 需要编译、JSX 需要转译），塞进 iframe 只会白屏 —— 那等于制造一个**必然失败**的入口。它们保持「源码 + 高亮」。真要支持，前提是先有构建/转译管道，成本与收益不成比例。

### 5. 不把「打开方式」做成每次弹选择

按类型自动决定，让「点一下就能看」保持一步操作；用户的选择权体现在**兜底出口**上（应用打不开时明确告知，并给出「用系统默认程序打开」），而不是每次打开都问一遍。

### 6. 应用打不开的文件一律有兜底出口，四个入口都不留静默失败

出路统一为「交给系统默认程序」，走**自定义 Rust 命令** `open_with_default_app`（与 [files.rs](../../src-tauri/src/commands/files.rs) 既有的 `reveal_in_explorer` 同形）：Windows `explorer.exe <path>`、macOS `open`、Linux `xdg-open`。

四个入口的反馈形态：点击 → toast + 动作；右键 → 类型专属项「用系统默认程序打开」；**拖入 → 计数提示，恰好 1 个被忽略文件时附同一动作**（≥2 个只报计数，避免一个动作拉起 N 个外部程序）；打开失败 → toast + 动作。

### 7. 无后缀文件一律允许「试读」，「大」只影响「要不要先问一句」

`isLargeExtensionlessFile`（≥1MB）用于**打开前确认**与**文件树图标分级**，语义上**不是**「能不能打开」。真正的失败点在后端读取（非 UTF-8 时 `read_text_file` 报错），所以不必事先靠大小猜 —— 此前「≥1MB 的无后缀文件一律打不开」的结果是最大的那些构建日志永远点不开。

### 8. 判定的唯一事实来源是 `fileKind.ts`，矩阵写在本 ADR

新增文件类型或改打开方式时：先改 `fileKind.ts`，再回来更新本表。代码里只放一行指向本 ADR，不复制表格（两处表格必然漂移）。

## 理由

1. **「点了没反应」是最坏的一类失败** —— 用户无法区分「应用坏了」「文件坏了」「我点错了」。四类入口给出反馈的成本极低，收益是消除整个静默失败类别。
2. **兜底走自定义命令而不是 `plugin-shell`** —— 能力集里是 `shell:default`，其默认 scope **只放行 `http(s)://` / `tel:` / `mailto:`**；要打开本地路径得把 `allow-open` 的 scope 放宽到 `**`，那是为兜底入口**扩大攻击面**。自定义命令不经过 ACL（ACL 只管插件命令），不动能力集、不加依赖。
3. **Windows 用 `explorer.exe <path>` 而不是 `cmd /c start`** —— 后者有两个坑：文件名里的 `&` `^` `%` `(` 在无空格时不会被加引号，会被 cmd 当元字符解释；且 cmd 是控制台程序，从 GUI 子进程（`windows_subsystem = "windows"`）里起会闪黑窗。
4. **抽象不拆、术语收敛** —— 拆 `isDocumentFile` 只会把「挂不挂预览」这一个判断散成两处，而渲染路径的差异本来就由组件边界承担。
5. **试读而非预判** —— 见决策 ②；这是把「猜」换成「试」，失败信息来自真实读取而不是大小阈值。

## 备选方案

**每次打开都弹「选择打开方式」** —— 被否决：把「点一下就能看」变成两步操作，绝大多数打开都是明确的（md 就是看、png 就是看图）；而且用户真正的痛点不是「选不了」，是「打不开时没有出路」。

**把 `.vue` / `.jsx` / `.tsx` 纳入沙箱预览** —— 被否决：它们不是合法 HTML，进 iframe 只会白屏（必然失败的入口）。若将来有转译管道可重新评估。

**放宽 `plugin-shell` 的 `open` scope 到本地路径** —— 被否决：见理由 ②，为兜底入口扩大攻击面不划算。

**HTML 强制降级为「源码 + 预览」（或加「纯源码开关」）** —— **曾提出，核代码后撤回**：现状只在 `wysiwyg` 时降级，用户在 html 上的「源码 / 分屏 / 演示」选择本来就是被尊重的（`effectiveEditorMode` 原样透传、`onSelectMode` 只对源码-only 文件早退）。当初的提案建立在「html 被强制 split」这一**误读**之上（把「wysiwyg 降级」当成了「一律降级」），故不做。

**在应用内渲染 PDF / 二进制** —— 范围外：本 ADR 只决定「打不开时交给系统默认程序」。PDF 另有一条**导出**链路（见 [ADR-0010](0010-pdf-export-via-webview2-printtopdf.md)），与本 ADR 不冲突也不重叠。

## 后果

**正面**

- 四个入口口径一致：能打开的打开，打不开的给出路，没有一个静默失败。
- 判定与行为的边界明确（谁负责判定 = `fileKind.ts`；谁负责打开 = 各入口），新增类型时知道该动哪一处。
- 「为什么不做 X」（每次弹选择 / `.vue` 预览 / 放开 shell scope / HTML 纯源码开关）有了留档，不必每次重新论证。

**负面**

- 兜底出口依赖系统关联：系统没装能打开 `.zip` 的程序时，`open_with_default_app` 会失败 → 走 `confirm`/`alert` 报错（错误提示是二线的兜底）。
- 拖入的提示是**计数**而非清单：一次性拖入多个打不开的文件时，用户看不到具体是哪几个（取舍见决策 ⑥）。
- 矩阵写在本 ADR：改判定不改此处就会漂移（决策 ⑧ 只放了一行指针，靠评审发现）。

## 实施边界

### 文件改动

- 判定：[src/utils/fileKind.ts](../../src/utils/fileKind.ts)（文件头指向本 ADR）
- 兜底出口：`src-tauri/src/commands/files.rs`（`open_with_default_app`）、`src/services/fileSystem.ts`、[src/stores/useFileOpsStore.ts](../../src/stores/useFileOpsStore.ts)（#307）
- 四个入口：[TreeNode.vue](../../src/components/TreeNode.vue)（点击 toast / 右键项）、[dropPlan.ts](../../src/utils/dropPlan.ts)（`unsupportedFiles`）+ [useDragDrop.ts](../../src/composables/useDragDrop.ts) + [useFileActions.ts](../../src/composables/useFileActions.ts)（`notifyUnsupportedDropFiles`，拖入反馈 #317）、`App.vue`（`effectiveEditorMode`、接线）
- 文档：本 ADR、[CONTEXT.md](../../CONTEXT.md)（「非 markdown 文件处理」一节 + 术语表）、`CHANGELOG.md`

### 测试

- 前端：`fileKind.test.ts`（`isMarkdownFile` / `isHtmlFile` / `isDocumentFile` / `isSourceOnlyFile` —— 此前零覆盖）、`dropPlan.test.ts`（`unsupportedFiles` 的四个口径：单个 / 多个 / 混投 / 缺失路径与目录不计入）
- e2e：`file-operations.spec.ts`（`.pdf` 右键只给兜底项、无后缀大文件先确认、非 UTF-8 兜底）、`drag-drop.spec.ts`（拖入不支持类型出现提示）

### 范围外

- **应用内渲染 PDF / Office / 音视频**：一律交给系统默认程序。
- **白名单外的文本类型**（如 `.xhtml`、`.jsp`）：按「应用打不开」处理，走兜底出口；扩展可编辑白名单是独立的小改，需要时另开 issue。
- **拖入时被忽略的目录**（多目录 / 目录与文件混投）：语义是「一个窗口只能开一个工作区」，与「打开方式」不是一回事（见 issue #318）。
- **`.vue` / `.jsx` / `.tsx` 的实时预览**：需要转译管道，不在本 ADR 范围。
