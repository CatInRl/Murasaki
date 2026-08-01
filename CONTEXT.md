# Glossary

本文件是项目的领域词汇表，仅记录术语定义，不包含实现细节或决策理由（那些放 ADR）。

## 应用名称 (Application Name)

**Murasaki** —— 以日本平安时代女作家紫式部（Murasaki Shikibu）命名，她是《源氏物语》作者、人类历史上第一位长篇小说作家。"书写创作"的化身，与 markdown 工具的"文字创作"气质契合。同时是 Fate/Grand Order 中的文学系 Caster 角色名。

- 应用显示名：Murasaki
- 二进制名：`murasaki.exe`
- app data 目录：`%APPDATA%\murasaki`
- 窗口标题：`Murasaki`

## 数据持久化 (Data Persistence)

应用级状态落盘结构，位于 app data 目录 `%APPDATA%\murasaki\`：

```
murasaki/
├── settings.json              # 系统设置（UI 模式、编辑模式、显示隐藏文件等）
├── recent.json                # 最近打开记录（{ files: [], folders: [] }）
├── tabs.json                  # 打开的 tab 列表
│                              # 字段：{ path, lastMtime, cursor: {line, ch}, scroll: {x, y}, active }
└── drafts/                    # 未保存草稿目录
    └── <sha1-of-path>         # 每 tab 一份草稿，无后缀
```

- `settings.json` / `recent.json` / `tabs.json` 通过 Tauri `tauri-plugin-store` 读写。
- 草稿通过 `fs` plugin 直接操作文件，内容为 markdown 文本。
- 路径用 SHA-1 哈希作为草稿文件名，避免路径中非法字符问题。

## 菜单结构 (Menu Structure)

应用顶部菜单栏包含五项。各项及其子项、快捷键如下：

### 文件 (File)

- 新建文件…（`Ctrl+N`）
- 新建文件夹…
- 打开文件…（`Ctrl+O`）
- 打开文件夹…（`Ctrl+Shift+O`）
- 最近打开 ▸
  - 文件夹 ▸（最近 5 个）
  - 文件 ▸（最近 5 个）
- 保存（`Ctrl+S`）
- 另存为…（`Ctrl+Shift+S`）
- 导出 HTML… —— 导出当前 tab 为独立 HTML，弹出"另存为"对话框。
- 导出 PDF… —— 导出当前 tab 为 PDF（WebView2 PrintToPdf 静默导出，0.4.0 起）。
- 复制为富文本 —— 将当前 tab 渲染后的富文本（含格式）复制到系统剪贴板，粘贴到 Word/飞书等保留格式（0.4.0 起）。
- 关闭标签页（`Ctrl+W`）
- 重新加载文件（`Ctrl+R`）—— 手动刷新外部修改
- 关闭工作区 —— 关闭后回到欢迎页（空状态），显示打开入口与最近打开列表。
- 设置… —— 打开系统设置窗口，位于"退出"前。
- 退出（`Ctrl+Q`）

### 编辑 (Edit)

- 撤销（`Ctrl+Z`）
- 重做（`Ctrl+Y`）
- 剪切（`Ctrl+X`）
- 复制（`Ctrl+C`）
- 粘贴（`Ctrl+V`）
- 全选（`Ctrl+A`）
- 查找…（`Ctrl+F`）—— 当前文件内搜索
- 替换…（`Ctrl+H`）—— 当前文件内替换
- 在文件中查找…（`Ctrl+Shift+F`）—— 跨文件搜索

### 段落 (Paragraph)

markdown 格式操作菜单：

- 标题 1（`Ctrl+1`）
- 标题 2（`Ctrl+2`）
- 标题 3（`Ctrl+3`）
- 标题 4（`Ctrl+4`）
- 标题 5（`Ctrl+5`）
- 标题 6（`Ctrl+6`）
- 普通（`Ctrl+0`，取消标题）
- ---
- 代码块（`Ctrl+Shift+K`）
- 引用块（`Ctrl+Shift+Q`）
- 无序列表（`Ctrl+Shift+]`）
- 有序列表（`Ctrl+Shift+[`）
- 任务列表（`Ctrl+Shift+X`）
- 水平分隔线
- 插入表格… —— 弹对话框输入行列数，插入空表格模板

### 主题 (Theme)

预设四套 markdown 渲染样式：

- GitHub
- Newsprint
- Night
- Academic

### 帮助 (Help)

- 查看文档 —— 打开项目 GitHub Pages 或本地 README
- 关于 Murasaki
- 检查更新… —— 检查是否有新版本，有则弹对话框显示版本号与发布说明，可选「立即更新 / 稍后」。0.4.0 起通过 Tauri `updater` plugin + GitHub Releases 实现（详见 [ADR-0012](docs/adr/0012-auto-update-via-tauri-updater-with-github-releases.md)）。启动时静默检查更新（可在设置关闭），有新版本时菜单图标显示红点提示。

## 编辑模式 (Edit Mode)

用户与 markdown 内容交互的方式。本项目支持三种（0.3.0 起）：

- **源码模式 (Source Mode)** —— 纯 markdown 源码编辑，CodeMirror 6 占满编辑区，无预览区。
- **分屏模式 (Split Mode)** —— 界面分为源码编辑区与渲染预览区，输入时预览实时更新。默认模式。
- **所见即所得 (WYSIWYG Mode)** —— 用户直接在渲染结果上编辑，所见即所得。通过 CodeMirror 6 ViewPlugin + Decoration 隐藏 markdown 语法标记实现（Typora 路线），源文件始终是纯 markdown 文本，不引入第二套文档模型。Agent 提案在所有模式原生兼容。

三种模式共用同一 CodeMirror 6 实例，**全部支持运行时切换**（无需重启）：

- `source` ↔ `split`：运行时切换（仅显隐预览区 + 调整布局）
- `wysiwyg` ↔ 其他：运行时切换（叠加/移除 WYSIWYG ViewPlugin）

切换入口：通过系统设置窗口的"编辑器"分类切换。详见 [ADR-0008](docs/adr/0008-wysiwyg-via-codemirror6-typora-approach.md)。

### WYSIWYG 功能优先级（0.3.0）

- **P0（必须）**：行级语法标记隐藏 + 基础渲染（标题/粗体/斜体/删除线/行内代码/列表/引用/分隔线）
- **P1（应该）**：块级元素 widget（代码块/链接/图片/表格/数学公式/Mermaid）
- **P2/P3（遗留后续版本）**：YAML frontmatter 卡片 / emoji 短代码替换 / 脚注 / TOC / HTML 内联

### WYSIWYG 补全项（0.4.0）

0.4.0 补齐 0.3.0 遗留的 P2/P3 项（除 TOC 移至 0.5.0）：

- **Emoji 短代码替换** —— WYSIWYG 模式下 `:smile:` 等短代码直接渲染为 emoji 字符（修改源码替换为 emoji 字符，非仅视觉隐藏）。详见 issue #99。
- **YAML frontmatter 卡片交互** —— frontmatter 渲染为卡片，点击切源码模式并定位到 frontmatter 起始行。详见 issue #100。
- **脚注定义原位渲染** —— `[^1]` 脚注定义在原位渲染为脚注列表项（而非文末汇聚），点击引用跳转。详见 issue #101。
- **内联 HTML 安全渲染** —— 通过 DOMPurify 净化 + 白名单标签渲染内联 HTML，防 XSS。详见 issue #103。
- **TOC 支持** —— 移至 0.5.0（当前已有大纲视图覆盖导航需求）。详见 issue #102。

### WYSIWYG 光标行为

- 光标在当前段：所有语法标记可见（dim 灰色 + 缩小字号）+ 渲染样式保留
- 光标离开当前段：所有语法标记隐藏 + 渲染样式保留
- "当前段"定义：光标所在段落（空行分隔的连续文本行）
- Agent 提案 decoration 优先级高于 WYSIWYG 隐藏 decoration，提案覆盖范围不隐藏语法标记

## 主题 (Theme)

markdown 渲染样式的预设组合，影响预览区的内容外观（标题字体、代码块配色、引用块边框等）。通过"主题"菜单切换。每个主题由一个 CSS 文件 + 一个 Shiki 代码主题组成，换主题时整套视觉联动切换。

预设四套：
- **GitHub** —— GitHub 风格，亮色，通用。
- **Newsprint** —— 报纸风格，亮色，衬线字体。
- **Night** —— 暗夜风格，暗色。
- **Academic** —— 学术风格，亮色，正式排版。

不支持用户自定义导入。

## UI 模式 (UI Mode)

应用窗口的视觉模式（亮色 / 暗色 / 跟随系统），影响侧栏、菜单、编辑器背景等应用级 UI。与 markdown 主题独立。通过系统设置切换，不暴露在主菜单中。

## 系统设置 (System Settings)

应用级配置入口，形态为**独立的 Tauri 多窗口**（0.3.0 起，详见 [ADR-0009](docs/adr/0009-settings-window-as-tauri-multi-window.md)）。左侧分类导航，右侧表单。通过"文件 → 设置…"打开，作为独立 OS 窗口存在（可独立最小化/关闭，主窗口不被遮挡）。

### 设置分类（0.4.0，3 个）

- **常规** —— UI 模式（亮色/暗色/跟随系统）/ 显示隐藏文件 / 显示 Agent 面板 / 默认图片目录 / 语言（中文/English，0.4.0 起，详见 [ADR-0013](docs/adr/0013-i18n-via-vue-i18n-with-zh-cn-and-en-bilingual.md)）/ 启动时检查更新（0.4.0 起，默认开）
- **编辑器** —— 编辑模式（source/split/wysiwyg）/ 字体大小 / 行高 / 字体族 / 显示行号 / 软折行
- **AI** —— Provider 列表 + 编辑表单（类型含 OpenAI 兼容与 Anthropic，0.4.0 起，详见 [ADR-0011](docs/adr/0011-provider-interface-abstraction-with-openai-and-anthropic-dual-implementation.md)）/ 默认 Provider / 高级参数折叠区（4 项统一设置：Agent 循环轮数上限 / 单次请求 token 上限 / 累计 token 软上限 / propose_replace 二次确认阈值）

不再设置「主题」分类（markdown 主题通过 OS 原生菜单切换）和「快捷键」分类（后续版本）。

### 保存模型（0.3.0 起）

显式 Save 模型（对齐参考设计 footer 的「恢复默认 / 保存」按钮）：

- 改动暂存在 draft，点「保存」才落盘 + 触发副作用
- 点「恢复默认」重置当前分类
- 关闭未保存弹确认（保存/不保存/取消，与 tab 关闭未保存逻辑一致）
- 副作用统一触发（一次 save 把所有改动一次性应用，通过 Tauri event 通知主窗口）

## 编辑器配置 (Editor Configuration)

CodeMirror 6 的基础配置项：

- **行号** —— 默认显示。可在系统设置中关闭。
- **软折行**（Word Wrap）—— 默认开启。长行视觉折行但不修改源码。可在系统设置中关闭。

## 欢迎页 (Welcome Page)

应用无工作区时的空状态展示。居中显示：

- Murasaki 标志与名称。
- "打开文件"按钮（`Ctrl+O`）。
- "打开文件夹"按钮（`Ctrl+Shift+O`）。
- 最近打开列表（文件夹在前、文件在后，各 5 项，点击直接打开）。
- 底部：版本号 + "设置"链接。

**"新建文件"无工作区时的行为** —— 不依赖工作区，创建无标题 tab 并打开编辑器。保存时弹出"另存为"对话框让用户选择磁盘位置。保存后若该位置处于某个已打开的工作区内，文件树随之更新。

**"打开文件"无工作区时的行为** —— 打开单个 `.md` 文件作为独立 tab，不自动设工作区。侧栏保持空（显示欢迎页遮蔽）。用户想浏览文件树需显式"打开文件夹"。

## 工作区 (Workspace)

用户通过对话框显式选择的一个目录。应用获得该目录子树的读写权限。无预设全局路径，无跨工作区操作。

## 文件操作 (File Operation)

在工作区内对 markdown 文件及目录支持的操作，完整集合为：

- **查看** —— 读取文件内容到编辑器。
- **编辑保存** —— 修改文件内容并写回磁盘。
- **新建** —— 创建新文件或新目录。
- **删除** —— 删除文件或目录（含非空目录），送入系统回收站（Windows Recycle Bin / macOS Trash），不直接销毁。删除前弹二次确认对话框，列出待删项。支持多选批量删除。删除后无法通过 Ctrl+Z 恢复，用户须从系统回收站手动找回。
- **重命名** —— 修改文件或目录名。
- **移动** —— 在工作区子树内移动文件或目录。
- **拖拽移动** —— 通过拖拽改变文件在树中的位置，等价于"移动"操作（物理改变磁盘路径），不改变显示排序规则。

非工作区路径不允许任何操作（外部拖入除外，见下）。

## 拖拽语义 (Drag-and-Drop Semantics)

文件树支持两类拖拽：

### 工作区内拖拽（移动）

- 拖到目录项 → 移动进该目录。
- 拖到文件项 → 移动到该文件的同级目录。
- 拖到自身或自身的子目录 → 禁止，提示"不能将目录移动到自身或其子目录"。
- 视觉反馈：被拖项半透明，目标项高亮并显示 tooltip 标注目标路径。

### 外部文件拖入（复制）

- 从工作区外拖入文件/目录 → 复制到拖放目标目录。
- 复制为非破坏性操作，保留外部原文件。
- 跨文件系统边界（如 U 盘 → 工作区）同样复制。
- 文件名冲突时弹窗提示"覆盖 / 重命名 / 取消"。

## 文件树排序规则 (Tree Sort Rule)

工作区内同目录下条目的显示顺序规则。固定规则，不支持用户自定义顺序。

### 优先级

1. **目录优先** —— 目录排在文件之前。
2. **字符类别分组**（组间顺序）：
   - 数字开头（`1.md`、`2.md`、`10.md`，按自然序而非字典序）
   - 英文开头（大小写不敏感，`apple.md` < `banana.md` < `Zebra.md`）
   - 中文开头（按拼音排序，应用内强制 `zh-CN` locale，不依赖系统设置）
   - 其他字符开头（按 Unicode 码点序）
3. **组内排序** —— 数字自然序、英文字母序、中文拼音序。

### 实现路径

Rust 端使用 `lexical-sort` crate 或调用 Windows `StrCmpLogicalW` API。应用内强制 `zh-CN` locale 进行中文拼音排序，确保跨用户行为一致。

### 目录内部排序

目录名同样按上述规则排序，与文件混在同一优先级（即目录之间排序、文件之间排序，目录组整体在文件组之前）。

## 文件树展示范围 (Tree Display Scope)

文件树展示工作区内的所有文件与目录（不过滤扩展名），以真实反映磁盘结构。但默认隐藏以下已知噪音：

- 版本控制目录：`.git/`、`.svn/`、`.hg/`
- 系统文件：`.DS_Store`、`Thumbs.db`
- 依赖目录：`node_modules/`

系统设置中提供"显示隐藏文件"开关（默认关闭），开启后展示全部。

目录默认折叠，点击展开。

## 非 markdown 文件处理 (Non-Markdown File Handling)

文件树中点击非 markdown 文件时按扩展名分流：

- **markdown 文件**（`.md`、`.markdown`）—— 在新标签页打开编辑。
- **图片文件**（`.png`、`.jpg`、`.jpeg`、`.gif`、`.svg`、`.webp`）—— 应用内弹出轻量预览窗。
- **其他类型** —— 暂不支持，提示"无法打开此文件类型"。

## 文件树右键菜单 (Tree Context Menu)

在文件/文件夹上右键弹出菜单，项如下。支持多选（Ctrl+点击）批量操作。

### 文件/文件夹右键

- **打开**（仅文件）—— 在新 tab 中打开。和双击行为一致。
- **重命名…** —— 树内就地编辑（文件名变为可编辑 input），类似 Windows 资源管理器。
- ---
- **新建文件…**
- **新建文件夹…**
- ---
- **剪切**（`Ctrl+X`）—— 记录文件路径到应用内剪贴板。
- **复制**（`Ctrl+C`）—— 记录文件路径到应用内剪贴板。
- **粘贴**（`Ctrl+V`）—— 粘贴时做**复制**（非移动），与"拖拽是移动"形成两个独立通道。
- ---
- **删除**（`Delete`）—— 送入回收站，弹确认对话框。
- ---
- **在文件资源管理器中打开**（`Ctrl+Shift+R`）—— 调用系统资源管理器打开所在目录。
- **复制路径** —— 复制绝对路径到系统剪贴板。
- **复制相对路径** —— 复制相对工作区根的路径。

### 空白区域右键

- **新建文件…**
- **新建文件夹…**
- **粘贴**（`Ctrl+V`）—— 粘贴到工作区根目录。
- ---
- **在文件资源管理器中打开**（`Ctrl+Shift+R`）—— 打开工作区根目录。

## 侧栏 (Sidebar)

应用左侧的单一导航区域，互斥展示以下两种视图之一：

- **文件树视图 (File Tree View)** —— 展示工作区的目录树结构。快捷键 `Ctrl+Shift+E`。
- **大纲视图 (Outline View)** —— 展示当前打开文件中的所有 markdown 标题（`#` ~ `######`），按文档顺序排列。快捷键 `Ctrl+Shift+M`。

两种视图不能同时显示。切换入口：
- 侧栏顶部两个图标按钮（发现性入口，新用户可见）。
- 快捷键（效率入口，老用户偏好）。

## 大纲 (Outline)

当前打开文件中的 markdown 标题列表。每项包含层级、文本、所在行号。由 Rust 端解析生成，基于文件 mtime 缓存，未变更则不重算。点击大纲项跳转至编辑器对应行并同步滚动预览至对应锚点。

## 标签页 (Tab)

主窗口中一个打开文件的会话状态，包含文件路径、编辑器实例内容、光标位置、滚动位置、修改标志。同一时刻可打开任意数量标签页，无上限。标签页状态在应用关闭时持久化，下次启动恢复。

关闭未保存修改的标签页时，弹出"保存 / 不保存 / 取消"对话框确认。

tab 标题后加 `•` 表示未保存修改。

tab 栏 UI 细节：

- **标题** —— 仅显示文件名，hover tooltip 显示完整绝对路径。
- **关闭按钮** —— 每个 tab 右侧常驻 X 按钮。
- **新建按钮** —— tab 栏右侧 "+" 按钮，行为和 `Ctrl+N` 一致（创建无标题 tab）。
- **中键关闭** —— 支持中键点击关闭 tab。
- **关闭最后一个 tab** —— 回到欢迎页，标签栏消失。

## 状态栏 (Status Bar)

主窗口底部的窄条（约 20-24px 高），始终位于最底部。跨文件搜索结果面板展开时位于状态栏之上，不覆盖状态栏。

- **左侧** —— 当前文件路径（相对工作区根目录，如 `notes/2024/01.md`）。
- **右侧** —— 光标位置（`行:列`）、字符数、字数。

字数统计口径：按 Unicode 字符计数，不含空格。中英文统一计数，显示如 `1234 字`。

全屏模式下（`F11`）状态栏自动隐藏，退出全屏恢复。也可通过快捷键 `Alt+Shift+S` 手动切换显隐。

## 快捷键体系 (Keyboard Shortcuts)

应用全局快捷键清单。已审查无冲突。

### 文件 (File)
- `Ctrl+N` —— 新建文件
- `Ctrl+O` —— 打开文件
- `Ctrl+Shift+O` —— 打开文件夹
- `Ctrl+S` —— 保存
- `Ctrl+Shift+S` —— 另存为
- `Ctrl+W` —— 关闭当前 tab
- `Ctrl+R` —— 重新加载当前文件（手动刷新外部修改）
- `Ctrl+Q` —— 退出

### 编辑 (Edit)
- `Ctrl+Z` —— 撤销
- `Ctrl+Y` —— 重做
- `Ctrl+X` —— 剪切
- `Ctrl+C` —— 复制
- `Ctrl+V` —— 粘贴
- `Ctrl+A` —— 全选
- `Ctrl+F` —— 当前文件查找
- `Ctrl+H` —— 当前文件替换
- `Ctrl+Shift+F` —— 跨文件搜索

### 段落 (Paragraph)
- `Ctrl+1` ~ `Ctrl+6` —— 标题 1-6
- `Ctrl+0` —— 普通（取消标题）
- `Ctrl+Shift+K` —— 代码块
- `Ctrl+Shift+Q` —— 引用块
- `Ctrl+Shift+]` —— 无序列表
- `Ctrl+Shift+[` —— 有序列表
- `Ctrl+Shift+X` —— 任务列表

### 视图 (View)
- `Ctrl+Shift+E` —— 切换到文件树视图
- `Ctrl+Shift+M` —— 切换到大纲视图
- `Ctrl+Tab` —— 切换到下一个 tab（按显示顺序）
- `Ctrl+Shift+Tab` —— 切换到上一个 tab（按显示顺序）
- `F11` —— 全屏切换
- `Alt+Shift+S` —— 切换状态栏显隐

## 滚动同步 (Scroll Sync)

分屏模式下编辑器与预览之间的双向滚动联动机制。基于 markdown-it 渲染时为每个块级元素注入的 `data-source-line` 属性（标注源码行号），实现源码行 ↔ 预览元素的精确映射。

- **方向** —— 双向。编辑器滚动 → 预览跟随；预览滚动 → 编辑器跟随。
- **触发** —— 滚动事件节流处理（约 50ms 一次），避免性能问题与循环触发。
- **预览交互边界** —— 预览区不增加点击元素跳转编辑器等额外交互。双向滚动同步已覆盖"读预览时编辑器跟随"的需求，额外交互会增加心智负担与潜在冲突。
- 例外：任务列表复选框（见下）。
- **内部链接处理** —— 预览区点击相对 `.md` 链接时拦截，在新 tab 打开；外部 URL（`https://`）调用系统浏览器打开；锚点链接（`#section`）滚动到预览中对应标题。

### 任务列表复选框 (Task Checkbox Toggle)

预览区渲染 `- [ ]` / `- [x]` 为可点击复选框。点击切换状态，反向改写编辑器源码中对应行的 `[ ]` ↔ `[x]`。

## 外部修改处理 (External Change Handling)

运行中文件被外部程序修改或删除时的处理机制。采用 Rust 端 `notify` 监听（C）+ 焦点触发处理（B）的组合策略：

1. 文件在外部被修改 → Rust 推送事件，前端标记对应 tab "有外部修改"。
2. 用户切回应用或切到该 tab 时处理待处理通知：
   - 当前 tab 未修改 → 静默重新加载（无打扰）。
   - 当前 tab 已修改 → 弹窗提供三个选项：
     - **加载磁盘版本** —— 丢弃本地修改。
     - **保留当前版本** —— 继续编辑，保存时覆盖磁盘。
     - **对比并手动合并** —— 进入对比窗口（见下）。
3. 文件在外部被删除 → 标记 tab "文件已丢失"，用户操作时提示。

### 对比窗口 (Compare Window)

用户选择"对比并手动合并"时弹出的并排窗口：

- 左侧：外部磁盘版本（只读）。
- 右侧：本地编辑器版本（可编辑）。
- 差异行用颜色高亮（绿 = 仅本地有，红 = 仅外部有），基于 `diff-match-patch` 行级 diff。
- 用户在右侧手动编辑，确认后保存即覆盖磁盘。

不做 3-way 自动合并，不引入 git 风格冲突标记。markdown 写作场景下二选一 + 手动对比已足够。

## 图片处理 (Image Handling)

markdown 中图片引用的插入与管理规则。

### 引用方式

- 统一使用**相对当前 markdown 文件的路径**，符合 markdown 标准，保证工作区可移植。
- 不采用 Base64 嵌入（文件膨胀、无法复用、git diff 灾难）。
- 不采用绝对路径（跨机器不可用）。

### 插入场景

1. **粘贴/拖入外部图片** —— 自动复制到 `<workspace>/assets/` 目录（不存在则创建）。
   - 文件名：`YYYYMMDD-HHmmss-<6位短哈希>.<ext>`，纯 ASCII，无冲突。
   - 编辑器插入：`![](assets/<生成的文件名>)`。
2. **从工作区文件树拖图片到编辑器** —— 不复制，直接写相对路径。
   - 路径为相对当前 markdown 文件的位置（如 `![](../images/a.png)`）。
3. **手动输入 `![](path)`** —— 用户自行确保路径正确，应用不干预。

### assets 目录

- 固定名为 `assets/`，位于工作区根目录。不隐藏，用户可见可管理。
- 未来可在系统设置中配置前缀路径。

### 内联预览

编辑器源码视图**不做**图片内联渲染（保持源码可读）。图片仅在右侧预览区渲染显示。

## YAML Frontmatter 支持

markdown 文件顶部的 YAML 元数据（`--- ... ---`），由 `markdown-it-front-matter` 插件解析。源码中保留纯文本，预览时渲染为卡片式：

- 标题（粗体）、日期（可读格式）、标签（彩色徽章）。
- 类似 Typora 的 frontmatter 渲染效果。

不在"段落"菜单中增加 frontmatter 操作项（高级功能，手动键入即可）。

## Emoji 短代码 (Emoji Shortcode)

预览中 `:smile:` `:rocket:` 等短代码自动渲染为 emoji 字符。由 `markdown-it-emoji` 插件处理。源码保持短代码文本不变。

## Mermaid 图表 (Mermaid Diagram)

markdown 代码块中 ` ```mermaid ` 语法的图表支持。由 `markdown-it-mermaid` 插件解析，前端 Mermaid.js 渲染为 SVG。

- 支持流程图（graph）、时序图（sequenceDiagram）、类图（classDiagram）等常用图表类型。
- 源码中代码块保持可编辑，预览时渲染为 SVG 图表。
- Mermaid.js 按需加载（首次渲染时动态导入）。

## 数学公式 (Math Formula)

LaTeX 语法的数学公式支持，使用 KaTeX 渲染（轻量、快速）。

- **行内公式** —— `$E=mc^2$`。
- **块级公式** —— `$$...$$` 或 `$$ ... $$`。
- 由 `markdown-it-katex` 插件解析，KaTeX 前端库渲染。
- KaTeX CSS 随 markdown 主题联动（亮色/暗色适配）。

## 导出 (Export)

支持将当前 tab 的 markdown 内容导出为多种格式。入口集中在"文件"菜单。

### HTML 导出

入口："文件 → 导出 HTML…"，弹出"另存为"对话框选择输出路径。

- 将预览区渲染结果嵌入 HTML 模板，引入当前 markdown 主题的 CSS，保证预览与导出一致。
- Shiki 代码高亮的 CSS 内联写入（不依赖外部文件）。
- 外部图片（`![](assets/a.png)` 等）自动读取并转为 Base64 内联，确保 HTML 文件独立可分发。
- 仅导出当前激活的 tab。

### PDF 导出（0.4.0 起）

入口："文件 → 导出 PDF…"，弹出"另存为"对话框选择输出路径。

- 采用 WebView2 PrintToPdf API 静默导出（Windows 优先），复用 `exportHtml()` 产出的 HTML，保证导出 PDF = 预览外观。
- 默认 A4 + 标准边距，0.4.0 不暴露页边距/纸张大小设置项。
- macOS/Linux 后续版本用 `window.print()` 打印对话框降级。
- 详见 [ADR-0010](docs/adr/0010-pdf-export-via-webview2-printtopdf.md)。

### 复制为富文本（0.4.0 起）

入口："文件 → 复制为富文本"（专用命令，复制整篇当前 tab）。

- 将当前 tab 渲染后的 HTML（含内联样式）作为富文本写入系统剪贴板，粘贴到 Word/飞书/邮件等保留格式。
- 复制范围：整篇当前 tab 内容（与导出 HTML 同源，但走剪贴板而非文件）。
- 不弹对话框，操作完成后 toast 提示"已复制富文本到剪贴板"。

## Agent (Agent Capability)

应用内置的 AI 助手能力，帮助用户编辑和管理 Markdown 文档。MVP 阶段不支持无工作区的独立文件（agent 在无工作区时整体禁用）。

### Agent 能力分层

为避免测试与讨论中的"全功能"语义漂移，约定 agent 能力分为以下七层，每层独立可测：

- **A. 上下文 UI 层** —— 上下文卡片显示、token 估算、× 移除、切 tab 跟随、工具调用条目（calling/done/error）的可见性与展开。
- **B. 工具后端集成层** —— 10 个工具（4 CM6 状态 + 3 文件 + 3 提议）通过 `executeTool` 直接调用的行为正确性，与 LLM 无关。
- **C. 真实 LLM 调用循环层** —— `sendMessage` 入口：provider 解析 → API key 获取 → 上下文拼装 → 流式请求 → 工具调用循环 → 收尾。
- **D. 提议渲染与接受层** —— CM6 装饰渲染 propose_insert / propose_replace / propose_new_file，✓/✗ 按钮，>50 行二次确认，严格失效。
- **E. 对话持久化与隔离层** —— `chats/{sha1(workspacePath)}.json.gz` + `chats/index.json`，500ms 防抖保存，工作区隔离，单实例锁，孤儿清理。
- **F. 上下文压缩与护栏层** —— 三层压缩（工具结果省略 → 滑窗+摘要 → 单请求截断），累计 token 跟踪与软上限。
- **G. 取消/中断与并发层** —— AbortController 中断、partial answer 保留、"⚠ 已中断"标记、关闭运行中 tab 合并弹窗、tab 切换后台继续。

### 全功能 E2E (Full-Stack Agent E2E)

指覆盖 A–G 全部七层的端到端测试集合。单测/集成测试不算"全功能 E2E"。当前现有 E2E 仅覆盖 A、B 两层（绕过 LLM），C–G 全部为零覆盖。

**API key 注入方式**：通过环境变量 `MURASAKI_E2E_API_KEY` 传入，不在任何文件落盘。

### Agent UX 遗留问题 (Agent UX Follow-ups)

全功能 E2E 测试中发现的 Agent 相关 UI/UX 不符合预期的问题（包括设置界面 UX 设计），记录为 GitHub issue 并标记 `agent-ux` 标签，待后续修复后由对应 E2E 测试回归验证。

### WYSIWYG 模式 (WYSIWYG Mode)

所见即所得编辑模式——用户直接在渲染结果上编辑。0.3.0 起实施，采用 CodeMirror 6 内 WYSIWYG（Typora 路线），与 Agent 功能原生协同（proposal 在 WYSIWYG 下直接渲染，无需切换源码模式）。详见 [ADR-0008](docs/adr/0008-wysiwyg-via-codemirror6-typora-approach.md) 与上方"编辑模式"章节。

## 搜索 (Search)

应用支持两个层次的搜索：

### 当前文件搜索 (File Search)

- 编辑器内查找 / 替换，由 CodeMirror 6 的 `search` 扩展提供。
- 入口："编辑 → 查找"（`Ctrl+F`）/ "编辑 → 替换"（`Ctrl+H`）。
- 支持正则表达式、大小写敏感、整词匹配。

### 跨文件搜索 (Workspace Search)

- 在工作区内搜索所有 `.md` 文件内容与文件名。
- 入口："编辑 → 在文件中查找…"（`Ctrl+Shift+F`）。
- 支持正则表达式、大小写敏感、整词匹配。
- 结果展示在底部面板（VS Code 风格），不占用侧栏。
- 结果分两组：
  - **文件名匹配** —— 文件名含搜索词的文件列表。
  - **内容匹配** —— 每个命中文件展开后显示匹配行 + 上下文。
- 点击结果项跳转到对应文件（若无 tab 则新开）并定位到匹配行。
- 实现路径：Rust 端遍历工作区 `.md` 文件，用 `regex` crate 匹配，返回命中行 + 上下文。

### 跨文件搜索重构（0.4.0）

issue #104 范围：性能修复 + UX 导航。

- **性能**：搜索改为异步可取消（AbortSignal）、结果上限（避免超大工作区卡顿）、增量返回（边搜边显示）。
- **UX**：结果折叠/展开导航优化、搜索进度指示、命中行号显示。
- 不改变搜索入口与基本能力（正则/大小写/整词）。

## 自动更新 (Auto Update)

0.4.0 起支持应用内自动检查与安装更新。详见 [ADR-0012](docs/adr/0012-auto-update-via-tauri-updater-with-github-releases.md)。

- **分发渠道**：GitHub Releases（`latest.json` manifest + `.sig` 签名文件，由 tauri-action 在 release 构建时自动生成）。
- **签名机制**：Tauri ed25519 签名密钥对（本地生成，与 Windows 代码签名证书独立）。私钥存 GitHub Actions secret，公钥 baked in 到客户端验签。
- **检查入口**：「帮助 → 检查更新…」手动检查；启动时静默检查（可在设置关闭）。
- **更新流程**：检查到新版本 → 弹自定义对话框显示版本号与发布说明 → 「立即更新」下载并安装 → 重启应用。
- **代码签名证书**（#15/#16）：stretch goal，非阻塞。证书就绪后只在 release.yml 加环境变量，updater 配置不变。
- **首次启用限制**：0.3.1 及更早版本无 updater plugin，无法自动升级到 0.4.0，用户需手动下载一次。

## 国际化 (Internationalization, i18n)

0.4.0 起支持中英双语 UI。详见 [ADR-0013](docs/adr/0013-i18n-via-vue-i18n-with-zh-cn-and-en-bilingual.md)。

- **框架**：vue-i18n 9.x（前端）+ Rust 端小型翻译表（菜单文案）。
- **支持语言**：`zh-CN`（中文，默认）/ `en`（英文）。
- **切换入口**：系统设置 → 常规 → 语言。切换即时生效（前端 vue-i18n 运行时切换 + Rust 菜单重建），无需重启。
- **持久化**：`settings.json` 的 `language` 字段。
- **不翻译的内容**：markdown 主题名（GitHub/Newsprint 等）、代码块语言标签、Agent 工具名、markdown 语法。
- **已知折衷**：前端 vue-i18n 与 Rust 翻译表是两套独立翻译源（0.4.0 仅 30 项菜单文案，可接受；语言数 ≥3 时评估统一方案）。

## 设计系统基础 (Design System Foundation)

0.3.0 整体 UX 对齐引入的设计系统基础设施。参考设计稿位于 `murasaki-ui-design/`。

### 设计 Token 体系

三层 token 体系（来自 `murasaki-ui-design/colors_and_type.css` + `.preflight/preflight.html`）：

- **Token 层**：`--murasaki-*` 语义 token（primary/popover/card/muted/border/ring/state-* 等）+ 尺寸 token（radius-sm/md/lg = 4/8/16px）
- **Tailwind 映射层**：`@theme inline` 把 token 映射为 Tailwind 4 的 `--color-*`（仅设计稿用，实现不引入 Tailwind，详见 [ADR-0006](docs/adr/0006-no-tailwind-keep-scoped-css.md)）
- **语义类回退层**：即便 Tailwind JIT 未编译，`.bg-popover`/`.text-foreground` 等 CSS 类仍生效

0.3.0 token 补全（在 [theme.css](src/styles/theme.css)）：
- 字号 token：`--murasaki-text-xs/sm/base/lg/xl/2xl`（12/13/14/16/20/24px）
- 阴影 token：`--murasaki-shadow-sm/md/lg/2`
- 布局 token：`--murasaki-menubar-height`（32px，仅设计参考用，应用内不实现 in-app menu bar，详见 [ADR-0007](docs/adr/0007-keep-tauri-native-menu-bar.md)）
- 过渡 token：`--murasaki-transition-fast`（120ms ease）

间距/字重/行高保留硬编码（不 token 化，避免 token 膨胀）。

### 图标库 (Icon Library)

统一使用 **`lucide-vue-next`**（Vue 3 组件形式的 lucide 图标集），替换所有 emoji + 内联 SVG + naive-ui NIcon。详见 [ADR-0004](docs/adr/0004-lucide-vue-next-as-unified-icon-library.md)。

- 按需引入（tree-shakeable），常用图标约 30-50 个，总增量 <50KB gzip
- 与设计系统的 `[data-icon]` mask 模式语义 1:1 对应
- 跨平台渲染一致，可继承 currentColor，响应主题

### naive-ui 主题化策略 (naive-ui Theming)

保留 naive-ui 作为组件库，通过 `NConfigProvider` + `themeOverrides` 把 naive-ui 的颜色/圆角/字体变量映射到 `--murasaki-*` token。详见 [ADR-0005](docs/adr/0005-keep-naive-ui-with-theme-overrides.md)。

- **保留 naive-ui 默认行为**：NModal 的焦点陷阱、NSelect 的虚拟滚动、NDropdown 的点击外部关闭、NTabs 的键盘导航等**行为**保留
- **视觉通过 themeOverrides 对齐**：颜色/圆角/字体/阴影映射到 `--murasaki-*` token
- **部分组件自建**：吐司/对话框/右键菜单/空态/错误态/加载态等与设计差异大的组件自建（全局 Pinia store + 单一 Teleport 容器 + Promise/数据驱动 API）

### 样式写法 (Styling Approach)

**不引入 Tailwind**，保留 scoped CSS + `--murasaki-*` token 变量。详见 [ADR-0006](docs/adr/0006-no-tailwind-keep-scoped-css.md)。

- 与设计系统的**语义**对齐（颜色/圆角/间距数值一致），但**写法**不一致（设计用 Tailwind 工具类，实现用 scoped CSS）
- 翻译规则：`bg-primary/10` → `background: rgba(147, 51, 234, 0.1)` 或 `color-mix(in srgb, var(--murasaki-primary) 10%, transparent)`
- 硬编码颜色清理是独立工作（如 [CompareWindow.vue](src/components/CompareWindow.vue) 的 16 处硬编码）

### 反馈系统组件模式 (Feedback System Pattern)

0.3.0 引入的反馈系统基础设施，统一模式：**全局 Pinia store + 单一 Teleport 容器 + Promise/数据驱动 API**，不依赖 naive-ui 的 NMessage/NDialog/NDropdown。

- **吐司系统**：`useToastStore` + `ToastContainer.vue`，6 变体（success/info/warning/error/progress/deleted），栈位置右上角
- **对话框系统**：`useDialogStore` + `DialogContainer.vue`，4 类型（alert/confirm/prompt/conflict），Promise-based API，按钮顺序"取消在左/确认在右"（与 naive-ui 默认相反），替换所有 36 处原生 `alert()/confirm()/prompt()`
- **右键菜单系统**：`useContextMenuStore` + `ContextMenuContainer.vue`，数据驱动（MenuItem 接口含 label/icon/shortcut/action/disabled/danger/separator），4 处右键菜单（TabBar/Editor/Agent 消息/TreeNode）

### 状态展示组件家族 (State Display Component Family)

0.3.0 引入的状态展示组件三兄弟，共享虚线边框容器与 props 模式，替换 naive-ui 的 NEmpty/NSpin/NSkeleton：

- **EmptyState**：空态，lucide `w-12 h-12 text-muted-foreground/50` 图标 + 标题 + 描述 + 可选操作按钮
- **ErrorState**：错误态，lucide `alert-triangle` 黄色图标 + 标题 + 描述 + "重试"按钮
- **Skeleton**：加载态，`h-4 bg-muted rounded animate-pulse` 骨架条（默认 4 行，宽度递减 100%/90%/95%/70%）

### 浮层组件 (Popover)

用 naive-ui **NPopover + themeOverrides** 对齐 token（不自建）。详见 [ADR-0005](docs/adr/0005-keep-naive-ui-with-theme-overrides.md)。

- 浮层是"纯容器"，NPopover 的视觉结构（圆角 + 边框 + 阴影 + 箭头）与设计规范一致，themeOverrides 足够对齐
- 内容由 slot 自定义（链接表单/图片插入表单/表格配置/UI 模式单选组等）
- trigger 统一用 `click`（hover 仅用于 tooltip，用 NTooltip）
