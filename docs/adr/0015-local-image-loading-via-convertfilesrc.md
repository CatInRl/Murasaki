# ADR-0015: 本地图片加载 via Tauri convertFileSrc

**日期**: 2026-08-03
**状态**: Accepted
**关联 Issue**: [#118](https://github.com/CatInRl/Murasaki/issues/118)

## 背景

在 Tauri WebView 中，`<img src="assets/photo.png">` 这样的相对路径无法加载——WebView 没有 HTTP 服务器，相对路径不是可访问的 URL。只有 `data:` base64、`tauri://` / `https://` 协议才能加载。

当前分栏预览（PreviewPane.vue）和 WYSIWYG（wysiwygPlugin.ts ImageWidget）都直接使用 markdown 中的原始路径，未做协议转换，导致本地图片无法显示。

## 决策

使用 Tauri 的 `convertFileSrc()` 将本地文件路径转为 `tauri://localhost/...` 协议 URL。

### 兼容四种图片 src 格式

| 格式 | 示例 | 处理方式 |
|---|---|---|
| 相对路径 | `assets/photo.png` | 解析为绝对路径（相对于当前文件所在目录），再 convertFileSrc |
| 绝对路径 | `C:\photos\image.png` | 直接 convertFileSrc |
| URL | `https://example.com/img.png` | 原样保留 |
| Base64 | `data:image/png;base64,...` | 原样保留 |

### 统一处理点

- **分栏预览**：markdown-it 自定义 renderer，在渲染 `img` 标签前拦截 src
- **WYSIWYG**：`ImageWidget.toDOM()` 中转换 url

## 备选方案

### Base64 编码

复用 `ImagePreviewModal.vue` 的 `read_binary_file` 逻辑，将图片读为 Base64。

- **否决原因**：大图编码慢，内存占用高。`convertFileSrc` 是 Tauri 为此场景设计的标准方案，性能远优于 Base64，且不需要 Rust 命令调用。

## 影响

- 需要新增路径解析工具函数（相对路径 → 绝对路径）
- markdown-it renderer 需要访问当前文件路径（通过闭包或 context）
- WYSIWYG ImageWidget 需要访问当前文件路径
- `convertFileSrc` 需要 Tauri allowlist 中包含 `asset` 协议
