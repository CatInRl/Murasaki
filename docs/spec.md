# Murasaki — 本地 Markdown 文件管理工具

## Problem Statement

在 Windows 上撰写 Markdown 文档时，用户面临以下困境：

- **通用代码编辑器**（VS Code / Notepad++）功能丰富但并非为 Markdown 写作设计 —— 缺少实时预览、段落格式快捷键、Markdown 主题切换等写作工具。
- **专用 Markdown 编辑器**（Typora、Obsidian）功能强大但体积臃肿（Electron 架构，安装包 >150MB），且引入知识库、双链等额外的概念负担。
- **在线编辑器**（Notion、语雀）依赖网络连接，无法离线使用，且数据存储在云端不受用户控制。

用户需要一个**轻量、本地优先、专为 Markdown 写作设计的桌面编辑器**，既能像 Typora 一样流畅写作，又能在本地文件系统中像 VS Code 一样管理 Markdown 文件。

## Solution

**Murasaki** —— 一个基于 Tauri 2.x 的轻量级本地 Markdown 文件管理编辑器，Windows 优先。以"文件管理"为核心定位，提供分屏编辑、文件树管理、大纲导航、跨文件搜索等能力，安装包控制在 ~10MB 量级。

核心体验：
- 打开文件夹后，左侧文件树管理所有 Markdown 文件。
- 分屏模式：左侧源码编辑（CodeMirror 6），右侧实时预览（markdown-it + Shiki）。
- 段落菜单提供标题、列表、代码块等格式操作的快捷键。
- 四套 Markdown 主题（GitHub、Newsprint、Night、Academic）影响预览区渲染样式。
- 支持 Mermaid 图表、KaTeX 数学公式、Emoji 短代码、YAML Frontmatter。

## User Stories

### 工作区与文件管理

1. 作为一名文档作者，我想通过菜单或快捷键打开一个文件夹作为工作区，以便集中管理该目录下的所有 Markdown 文件。
2. 作为一名文档作者，我想在左侧文件树中看到工作区内的所有文件和目录结构，以便快速定位要编辑的 Markdown 文件。
3. 作为一名文档作者，我想在文件树上右键进行新建文件/文件夹、重命名、删除、剪切、复制、粘贴等操作，以便像使用系统资源管理器一样管理文件。
4. 作为一名文档作者，我想用拖拽在工作区内移动文件或目录，以便快速整理文档结构。
5. 作为一名文档作者，我想从桌面或其他位置拖入文件到工作区，让其自动复制进来，以便将外部资源加入工作区。
6. 作为一名文档作者，我想看到文件树中非 Markdown 文件（如图片）的存在，以便确认 Markdown 中的图片引用路径是否正确。
7. 作为一名文档作者，我想点击图片文件时弹出预览窗口，以便快速查看图片内容。
8. 作为一名文档作者，我想在文件树上多选文件后进行批量删除，以便清理不需要的文档。

### 编辑与预览

9. 作为一名写作者，我想在分屏模式下看到左侧的 Markdown 源码和右侧的实时渲染预览，以便边写边看最终效果。
10. 作为一名写作者，我想在源码编辑器中看到行号，以便通过行号引用或定位内容。
11. 作为一名写作者，我想长段落自动软折行（视觉换行但不修改源码），以便在小窗口下也能舒适写作。
12. 作为一名写作者，我想在编辑器和预览之间双向滚动同步，以便任何时候都能对照源码和渲染结果。
13. 作为一名写作者，我想 Tab 键批量缩进、Shift+Tab 减少缩进来调整段落结构。
14. 作为一名写作者，我想在预览区点击任务列表的复选框来切换完成状态，以便快速标记任务，而不需要手动修改 `[ ]` → `[x]`。

### 标签页

15. 作为一名写作者，我想同时打开多个 Markdown 文件（每个一个标签页），以便在多篇文档之间快速切换。
16. 作为一名写作者，我想在标签页标题上看到未保存的修改标记（`•`），以便知道哪些文件有待保存的内容。
17. 作为一名写作者，我想关闭应用后下次启动时自动恢复上次打开的所有标签页，以便延续之前的工作。
18. 作为一名写作者，我意外退出应用后重新启动时能够恢复未保存的草稿内容，以便不丢失工作成果。
19. 作为一名写作者，我想用中键点击标签页来快速关闭它，以提高操作效率。
20. 作为一名写作者，我想通过 `Ctrl+Tab` / `Ctrl+Shift+Tab` 按显示顺序切换标签页，并且通过 `Ctrl+W` 关闭当前标签页。

### 段落格式化

21. 作为一名写作者，我想通过 `Ctrl+1` 到 `Ctrl+6` 快捷键快速设置标题层级，以便高效组织文档结构。
22. 作为一名写作者，我想通过快捷键插入代码块、引用块、无序列表、有序列表、任务列表，以便专注于写作而不用手动敲语法。
23. 作为一名写作者，我想通过对话框输入行列数后自动插入空表格模板，以便快速创建 Markdown 表格。
24. 作为一名写作者，我想通过快捷键插入水平分隔线，以便在文档中创建视觉分隔。

### 大纲导航

25. 作为一名读者，我想在左侧切换到大纲视图，看到当前文档的所有标题结构，以便快速了解文档整体框架。
26. 作为一名写作者，我想点击大纲中的标题项直接跳转到编辑器中对应位置，以便在大型文档中快速定位。

### 搜索

27. 作为一名写作者，我想在编辑器中通过 `Ctrl+F` 查找文本、`Ctrl+H` 替换文本，以便快速修改当前文档。
28. 作为一名写作者，我想通过 `Ctrl+Shift+F` 在工作区内所有 Markdown 文件中搜索关键词，以便找到包含特定内容的文件。
29. 作为一名写作者，我想搜索时匹配文件名和文件内容，以便不会遗漏以文件名为线索的相关文档。
30. 作为一名写作者，我想在搜索结果中直接跳转到匹配的文件和对应行，以便快速修改。

### 图片处理

31. 作为一名写作者，我想从剪贴板粘贴截图到 Markdown 文档，让图片自动保存到工作区的 `assets/` 目录并以相对路径引用，以便文档可移植。
32. 作为一名写作者，我想从文件管理器拖入图片到编辑器，让图片自动复制到 `assets/` 目录。
33. 作为一名写作者，我想从工作区文件树拖入已有图片到编辑器，以相对路径直接引用（不复制），以便复用已有图片。

### 主题与外观

34. 作为一名写作者，我想在四套 Markdown 主题（GitHub、Newsprint、Night、Academic）之间切换，以便根据不同的内容或心情选择合适的渲染风格。
35. 作为一名写作者，我想代码块的语法高亮跟随 Markdown 主题变化（如暗色主题下代码也用暗色配色），以便整套视觉保持一致性。
36. 作为一名写作者，我想在系统设置中选择应用 UI 的亮色、暗色或跟随系统模式，以便与工作环境协调。

### 扩展语法

37. 作为一名技术文档作者，我想在 Markdown 中写 Mermaid 图表（流程图、时序图等）并在预览中看到渲染后的 SVG 图表，以便用代码方式创建图表。
38. 作为一名学术写作者，我想用 `$...$` 和 `$$...$$` 写 LaTeX 数学公式并在预览中看到 KaTeX 渲染结果，以便在文档中包含数学内容。
39. 作为一名写作者，我想用 `:smile:` 这样的短代码插入 emoji，让预览中渲染为对应图标，以便表达情绪。
40. 作为一名文档作者，我想在 Markdown 文件头部写 YAML Frontmatter（标题、日期、标签）并在预览中看到卡片式渲染，以便管理文档元数据。

### 文件操作安全

41. 作为一名写作者，我不小心删除了文件后，想从系统回收站恢复它（而非永久删除），以便不会丢失重要文档。
42. 作为一名写作者，我在重命名或移动文件时若与已有文件冲突，我想看到"覆盖 / 重命名 / 取消"的选择对话框，以便处理冲突而不产生意外覆盖。
43. 作为一名写作者，我关闭有未保存修改的标签页时，我想弹出"保存 / 不保存 / 取消"对话框，以便不会误丢修改。

### 外部修改

44. 作为一名写作者，当文件被外部程序修改而当前标签页没有本地修改时，我想应用自动重载文件内容，以便始终看到最新版本。
45. 作为一名写作者，当文件被外部程序修改且当前标签页有本地修改时，我想看到提示对话框，选择加载磁盘版本、保留本地版本或进入对比窗口手动合并，以便掌控变更。
46. 作为一名写作者，当文件被外部删除时，我想看到"文件已丢失"的提示，以便知道发生了什么。

### 导出

47. 作为一名写作者，我想将当前文档导出为独立的 HTML 文件（图片 Base64 内联、样式内嵌），以便分享给他人或在浏览器查看。

### 系统设置

48. 作为一名用户，我想通过独立的设置窗口管理 UI 模式、编辑模式、最近打开记录等配置，以便所有设置集中在一个地方。
49. 作为一名用户，我在无工作区的状态下打开应用时想看到欢迎页（含打开入口和最近打开列表），以便快速开始工作。

### 状态栏

50. 作为一名写作者，我想在底部状态栏看到当前文件路径、光标位置和字数统计，以便随时了解编辑状态。
51. 作为一名写作者，我想在进入全屏模式时许愿状态栏自动隐藏（退出全屏恢复），以便最大化写作空间。

---

## Implementation Decisions

### 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | Tauri 2.x | 见 ADR 0002 |
| 前端框架 | Vue 3 + TypeScript | 响应式系统天然契合编辑器场景（频繁状态更新） |
| UI 组件库 | Naive UI | 国产、中文文档好、组件齐全（树、菜单、对话框）、暗色模式原生支持 |
| 编辑器 | CodeMirror 6 | 体积小、模块化、Markdown 专长、扩展系统灵活 |
| Markdown 解析 | markdown-it + 插件群 | 同步 API 与编辑器实时更新配合自然，插件生态最广 |
| 代码高亮 | Shiki | 双主题模式、TextMate 语法精准、与 Markdown 主题联动 |
| 数学公式 | KaTeX | 比 MathJax 更快更轻，Tauri 友好 |
| 图表渲染 | Mermaid.js | 按需加载，首次渲染时动态导入 |
| 前端构建 | Vite | Tauri 官方模板默认，速度最快 |

### 后端模块（Rust）

后端通过 Tauri 自定义命令暴露给前端，承担以下职责：

**files 模块**
- 遍历目录生成树结构（递归，一次返回完整 TreeNode）。
- 创建文件/文件夹、删除（走系统回收站）、重命名、移动、复制。
- 文件内容读取与写入（简单文本读写复用 `fs` plugin）。
- 搜索工作区：遍历 `.md` 文件，用 `regex` crate 做正则匹配，返回 `{filePath, lineNumber, lineContent, contextLines}`。
- 外部修改监听：使用 `notify` crate，文件变更时推送事件到前端。

**outline 模块**
- 解析 Markdown 文件，提取所有 `#` ~ `######` 标题行，返回 `[{level, text, line}]`。
- 基于文件 mtime 做缓存：若文件未变则直接返回缓存结果。
- 排序规则实现：使用 `lexical-sort` 或 Windows `StrCmpLogicalW`，强制 `zh-CN` locale。

**LaTeX/Mermaid 相关**
- LaTeX 解析和 Mermaid 解析均在前端完成（KaTeX 和 Mermaid.js 是 JS 库），后端不涉及。

### 前端模块（Vue）

**Pinia Store 分工**

- `useWorkspaceStore` —— 当前工作区路径、文件树数据（TreeNode[]）、排序规则、最近打开历史。
- `useTabsStore` —— 当前打开的标签页列表 `Tab[]`、激活索引、持久化与恢复逻辑。每个 `Tab` 包含 `{id, path, content, lastMtime, cursor, scroll, isDirty}`。
- `useSettingsStore` —— UI 模式、编辑模式、显示隐藏文件、行号/折行等配置，读写 `tauri-plugin-store`。
- `useSearchStore` —— 跨文件搜索查询、搜索结果、匹配高亮。

**组件树**

```
App.vue
├── TitleBar (原生菜单栏，由 Tauri 配置)
├── SplitPane
│   ├── Sidebar.vue
│   │   ├── SidebarTabs.vue (文件树/大纲切换按钮)
│   │   ├── FileTree.vue
│   │   │   └── TreeNode.vue (递归)
│   │   └── OutlinePanel.vue
│   ├── MainArea.vue
│   │   ├── TabBar.vue
│   │   ├── WelcomePage.vue (无文件时)
│   │   └── EditorPane.vue (分屏)
│   │       ├── SourceEditor.vue (CodeMirror 6)
│   │       └── PreviewPane.vue (markdown-it 渲染)
│   └── SearchPanel.vue (底部，跨文件搜索结果)
├── StatusBar.vue
├── ImagePreviewModal.vue (图片预览弹窗)
├── SettingsWindow.vue (独立窗口)
└── CompareWindow.vue (文件对比窗口)
```

**Composables**

- `useMarkdownRenderer` —— markdown-it 实例 + 插件链 + Shiki 集成。接受源码 string，返回 HTML string。纯函数，不依赖 Vue 响应式。
- `useScrollSync` —— 监听 source/pane 滚动事件，基于 `data-source-line` 映射计算目标滚动位置，节流 50ms，防循环触发。
- `useFileWatcher` —— 订阅 Rust 端 `file-changed` 事件，管理外部修改通知队列，焦点事件触发处理。
- `useEditorCommands` —— 封装 CodeMirror 编辑操作的通用函数（插入/替换/选区操作），供段落菜单和快捷键消费。
- `useConflictDialog` —— 统一文件冲突对话框逻辑。

### 数据模型（关键类型）

```
TreeNode:
  { name, path, type: "file" | "directory", children?: TreeNode[] }

Tab:
  { id, path, content, lastMtime, cursor: {line,ch}, scroll: {x,y}, isDirty, hasExternalChange }

OutlineItem:
  { level, text, line }

SearchResult:
  { filePath, matches: [{lineNumber, lineContent, contextBefore, contextAfter}] }

RecentEntry:
  { path, type: "file" | "folder", openedAt }
```

### 数据持久化

- `settings.json` / `recent.json` / `tabs.json` → `tauri-plugin-store` 读写 JSON 键值存储。
- 草稿 → `drafts/<sha1-of-path>`，通过 `fs` plugin 直接操作文件，无后缀，内容为纯 Markdown 文本。
- 草稿生命周期：
  - 保存 → 草稿删除。
  - 关闭/退出 → 若未保存则写入草稿。
  - 启动恢复 → mtime 一致则用草稿，不一致则弹窗（见 ADR 0001）。

### 菜单与快捷键

菜单结构见 CONTEXT.md「菜单结构」节。特殊项：

- "设置" → 打开独立模态窗口。
- "最近打开" → 分子菜单（文件夹、文件），各 5 项，从 `recent.json` 读取。
- "导出 HTML…" → 弹出另存为对话框，输出独立 HTML。
- "在文件中查找…" → 打开底部搜索面板。
- "检查更新…" → 占位，点击提示"暂不支持"。

### Markdown-it 插件链

```
markdown-it
  .use(markdown-it-emoji)
  .use(markdown-it-front-matter)
  .use(markdown-it-gfm-table)
  .use(markdown-it-task-lists)
  .use(markdown-it-footnote)
  .use(markdown-it-sub)
  .use(markdown-it-sup)
  .use(markdown-it-ins)
  .use(markdown-it-mark)
  .use(markdown-it-abbr)
  .use(markdown-it-container)
  .use(@shikijs/markdown-it)          // 代码高亮，跟随当前主题的 Shiki 主题
  .use(markdown-it-texmath)           // KaTeX 配合
  .use(markdown-it-multimd-table)     // 扩展表格语法
  .use(mermaid-plugin)                // Mermaid 图表
```

### 图片处理流程

1. 粘贴/拖入外部图片 → 生成文件名 `YYYYMMDD-HHmmss-<6位hash>.<ext>` → 复制到 `<workspace>/assets/` → 编辑器光标处插入 `![](assets/<filename>)`。
2. 从文件树拖入已存在图片 → 计算相对当前 md 文件的相对路径 → 编辑器光标处插入 `![](<relative-path>)`。

### 预览交互 vs 源码交互

- 预览区**不做一般性点击交互**（点击标题不跳转编辑器、点击链接不弹出菜单等）。
- 例外（已经确认的交互）：
  - 任务列表复选框可点击切换 ✅
  - 内部 `.md` 链接点击在新 tab 中打开 ✅
  - 外部 URL 链接调用系统浏览器打开 ✅
  - 锚点链接滚动预览 ✅
  - 滚动同步（纯滚动行为，不涉及点击）✅

### Tauri 权限 Scope

- `fs` plugin: allow/deny 限定在用户选定的工作区目录子树范围内。
- `dialog` plugin: 文件/文件夹选择对话框。
- `shell` plugin: `open` 功能（打开 URL 和文件资源管理器）。
- `store` plugin: 应用状态持久化。

---

## Testing Decisions

### 测试哲学

**只测试外部行为，不测试实现细节。** 以输入/输出边界为测试缝：
- Rust 端：Tauri command 函数的输入/输出。
- 前端：Pinia store 的初始状态 → 调用方法 → 新状态 / 副作用。Markdown 渲染管线的输入 markdown → 输出 HTML。

### 三条测试缝

**Seam 1：Tauri IPC 边界**

测试所有 `#[tauri::command]` 函数：
- 文件树生成：给定临时目录结构 → 返回正确 TreeNode。
- 大纲解析：给定 markdown 文本 + mtime → 返回正确的 `OutlineItem[]`，重复调用验证缓存。
- 跨文件搜索：在工作区中搜索 → 返回正确结果。
- 文件操作（CRUD）：创建/删除/移动/重命名 → 验证磁盘状态。
- 外部监听：模拟文件变更 → 验证事件推送。

工具：Rust 原生测试框架（`#[test]`），临时目录通过 `tempfile` 创建。

**Seam 2：Pinia Stores**

测试每个 store 的核心逻辑：
- `useTabsStore`：openTab / closeTab / saveTab / 草稿持久化 / 恢复逻辑。
- `useWorkspaceStore`：打开工作区 / 关闭工作区 / 文件操作 / 排序。
- `useSettingsStore`：读写设置 / 默认值。
- `useSearchStore`：搜索查询 / 结果存储。

工具：Vitest + `@pinia/testing`。Store 测试不渲染 Vue 组件，仅测试纯逻辑。

**Seam 3：Markdown 渲染管线**

`transformMarkdown(source: string, theme: string): string` 作为纯函数：
- 输入 → 输出快照测试。
- 边界用例：空文档、极长文档、含特殊字符、各插件组合。

工具：Vitest 快照测试。

### 不测的内容

- Vue 组件的 UI 渲染细节（不属于外部行为）。
- CodeMirror 6 内部行为（库的职责）。
- Tauri WebView 交互（端到端可用 Playwright 后续补充，不纳入首版）。

---

## Out of Scope

以下功能明确不在本版本的交付范围内：

- **WYSIWYG 编辑模式** —— 计划中的后续支持模式，当前只做分屏模式。
- **插件机制** —— 不提供第三方扩展能力。
- **双链 / 反向链接 / 知识图谱** —— 不引入 Obsidian 式的笔记网络概念。
- **PDF 导出** —— 用户可通过导出 HTML 后在浏览器中打印 PDF。真正的 PDF 导出留到后续。
- **复制为富文本** —— 粘贴到 Word/飞书时保留格式，留到后续。
- **Git 集成** —— 不内建版本控制功能。
- **自动更新** —— "检查更新"菜单项为占位，实际更新逻辑后续用 Tauri updater plugin 实现。
- **自定义 Markdown 主题导入** —— 仅使用预设四套主题。
- **移动端 / Linux 支持** —— Windows 优先，macOS 1.0 后考虑，Linux 暂不承诺。
- **协作编辑 / 实时同步** —— 纯本地工具，不涉及网络协作。
- **标签 / 分类系统** —— 不引入额外的分类元数据，以文件系统目录为唯一组织方式。
- **模板 / 代码片段** —— 不预设文档模板。
- **拼写检查** —— 后续通过 CodeMirror 扩展或外部库接入。

---

## Further Notes

### ADR 依赖

本 spec 的实现决策应结合以下 ADR 阅读：

- [ADR 0001：草稿恢复 + mtime 冲突解决](./adr/0001-draft-recovery-with-mtime-conflict-resolution.md)
- [ADR 0002：选择 Tauri 而非 Electron](./adr/0002-tauri-over-electron.md)

### 领域术语

本 spec 使用的所有术语（工作区、大纲、标签页、编辑模式、主题等）定义在 [CONTEXT.md](../CONTEXT.md) 中。不在此 spec 中重复定义。

### 实现优先级

建议实现顺序：
1. **骨架** —— Tauri + Vue 项目初始化，菜单栏、窗口布局、Naive UI 集成。
2. **编辑核心** —— CodeMirror 6 编辑器内嵌、markdown-it 渲染管线、Shiki 集成、分屏布局。
3. **文件系统** —— 工作区打开、文件树、文件操作、大纲解析。
4. **标签页** —— 多 tab、持久化、草稿恢复、修改标志。
5. **格式与导航** —— 段落菜单/快捷键、大纲视图、滚动同步。
6. **搜索** —— 当前文件搜索（CodeMirror）、跨文件搜索（Rust）。
7. **高级功能** —— Mermaid、KaTeX、Emoji、Frontmatter、图片处理。
8. **系统功能** —— 设置窗口、欢迎页、主题切换、导出 HTML、外部修改处理、对比窗口。
9. **打磨** —— 文件树右键菜单、文件冲突处理、删除确认、状态栏、快捷键审查。
