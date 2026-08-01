# ADR 0012: 自动更新分发渠道采用 Tauri updater + GitHub Releases

## 状态

已接受

## 背景

[CONTEXT.md](../../CONTEXT.md) 帮助菜单定义「检查更新…」当前为占位项，点击提示「暂不支持自动更新，请手动下载」。0.4.0 需将其改为真实功能。

现有发布管线（[.github/workflows/release.yml](../../.github/workflows/release.yml)）已具备：
- 推送 `v*.*.*` tag 自动触发
- 创建 GitHub Release（含 CHANGELOG 自动提取的 Release Notes）
- 多平台构建（Windows / macOS arm64 / macOS x64 / Ubuntu）通过 `tauri-apps/tauri-action@v0`
- 构建产物上传到 Release assets

[tauri.conf.json](../../src-tauri/tauri.conf.json) 当前 `plugins: {}`，未启用 updater。

### 代码签名与自动更新的关系（关键澄清）

经 grilling 确认，这两个概念需解耦：

- **Tauri updater 签名密钥对** —— Tauri 自带的 ed25519 密钥对，**仅用于校验更新包完整性**（客户端用 baked-in 公钥验签 `.sig` 文件，防止更新包被篡改）。可本地生成，不依赖任何 CA，不涉及采购。
- **Windows 代码签名证书**（issue #15/#16）—— 用于给 `.exe` / `.msi` 安装包签名，避免 SmartScreen 拦截。需要从 CA 采购或申请。

**用户决策：检查更新先不依赖证书，后续申请。** 即 0.4.0 自动更新使用 Tauri 自带密钥对（本地生成、立即就绪），代码签名证书作为 stretch goal 留在 0.4.0 里程碑但非阻塞项。证书就绪后，签名与 updater 互不影响（updater 仍用自己的 ed25519 密钥对）。

## 决策

自动更新采用 **Tauri updater plugin + GitHub Releases 作为分发渠道**：

### 1. 更新签名密钥对

本地生成 Tauri ed25519 密钥对（`tauri signer generate`）：
- **私钥**（`TAURI_SIGNING_PRIVATE_KEY`）—— 存为 GitHub Actions secret，仅在 release 构建时注入，用于对更新包签名生成 `.sig` 文件。
- **公钥**（`TAURI_SIGNING_PUBLIC_KEY`）—— 写入 `tauri.conf.json` 的 `plugins.updater.pubkey`，baked in 到客户端，用于运行时验签。

与 Windows 代码签名证书完全独立，不互相依赖。

### 2. Tauri 配置

`tauri.conf.json` 新增：

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/CatInRl/Murasaki/releases/latest/download/latest.json"
      ],
      "pubkey": "<TAURI_SIGNING_PUBLIC_KEY>",
      "dialog": false
    }
  }
}
```

- `endpoints` 指向 GitHub Releases 的 `latest.json`（由 tauri-action 在 release 构建时自动生成并上传）。
- `dialog: false` —— 不用 Tauri 默认弹窗，由前端自定义更新提示 UI（与现有设计系统一致）。

### 3. release.yml 调整

`tauri-apps/tauri-action@v0` 在检测到 `TAURI_SIGNING_PRIVATE_KEY` 环境变量时会自动：
- 对每个构建产物生成 `.sig` 签名文件
- 生成 `latest.json` manifest（含版本号、发布说明、各平台下载 URL + 签名）
- 上传到 Release assets

在 `build` job 的 env 中加入：

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

无其他工作流改动。

### 4. 前端 updater 集成

- `src-tauri/Cargo.toml` 加 `tauri-plugin-updater` 依赖。
- `src-tauri/src/lib.rs` 注册 plugin。
- 前端加 `@tauri-apps/plugin-updater` 依赖。
- 新建 `src/composables/useUpdater.ts` 封装检查 / 下载 / 安装逻辑。
- 「检查更新…」菜单项调用 `useUpdater.check()`：
  - 有新版本 → 弹自定义对话框显示版本号 / 发布说明 / 「立即更新 / 稍后」按钮。
  - 无新版本 → toast 提示「已是最新版本」。
  - 检查失败 → toast 提示错误。
- 「立即更新」→ 下载 + 安装 + 重启（updater plugin 提供 `downloadAndInstall` 方法）。
- 启动时静默检查更新（不弹窗，仅在状态栏或菜单图标显示红点提示有可用更新，点击触发上面的对话框）。启动静默检查可被设置项关闭。

### 5. 0.4.0 范围边界

- ✅ 自动更新核心流程（检查 / 下载 / 安装 / 重启）
- ✅ 自定义更新提示对话框（对齐设计系统）
- ✅ 启动时静默检查（可关闭）
- ⏸ Windows 代码签名证书（#15/#16，stretch goal，非阻塞；证书就绪后只需在 release.yml 加 `TAURI_PRIVATE_KEY` / `TAURI_CERTIFICATE` 环境变量，updater 配置不变）
- ❌ 后台下载进度条（0.4.0 用 indeterminate 进度条，后续版本可加 detailed progress）
- ❌ 增量更新（Tauri updater 不支持，后续也不做）

## 理由

1. **GitHub Releases 是零成本分发渠道** —— 项目已托管在 GitHub，release.yml 已在用 tauri-action 上传产物。updater 只需复用同一 Release assets，无需额外服务器 / CDN。
2. **tauri-action 自动生成 `latest.json`** —— 不需手动维护 manifest 文件，每次 release 自动更新。`endpoints` 指向 `releases/latest/download/latest.json` 永远拿到最新版。
3. **Tauri ed25519 签名密钥对本地生成、立即可用** —— 不依赖 CA、不需采购、不需审批。用户决策明确「检查更新先不依赖证书」，密钥对方案完全满足。
4. **签名密钥对与代码签名证书解耦** —— updater 用自己的密钥对验签更新包完整性，代码签名证书只影响 SmartScreen 体验。两者独立，证书就绪后互不影响。
5. **`dialog: false` + 前端自定义 UI** —— Tauri 默认弹窗样式与应用设计系统不一致，自定义对话框保证视觉统一（对齐 0.3.0 设计系统统一约束）。
6. **启动静默检查提升发现性** —— 用户不必主动点菜单才知道有更新；同时可关闭避免打扰。

## 备选方案

**自建更新服务器** —— 搭建独立后端托管 `latest.json` 与更新包。被否决：零额外功能收益（GitHub Releases 已满足）、增加运维成本、需用户配置额外域名。

**Squirrel / electron-updater** —— 非 Tauri 生态方案。被否决：与 Tauri 不兼容。

**Crates 的 `self_update`** —— Rust 端自更新 crate。被否决：不处理 WebView2 / Tauri 特定逻辑（如重启应用、跨平台安装包差异），且需自建 manifest 生成逻辑。

**仅手动更新（保持现状）** —— 不做自动更新，用户手动下载。被否决：用户体验差、版本碎片严重、0.4.0 主题「分发与输出能力」明确要求自动更新。

## 后果

**正面**
- 用户在应用内即可检查并安装更新，无需手动下载。
- 每次 release 自动产出 `latest.json` + `.sig` 文件，分发链路全自动。
- 更新包有签名校验，防篡改。
- 代码签名证书就绪后，无需改 updater 配置，只在 release.yml 加环境变量即可。

**负面**
- 需在本地生成并安全保管 Tauri 签名私钥（丢失则无法发布可被客户端接受的更新，需重新生成密钥对并发布一个用旧公钥签名的「换钥」版本，流程复杂）。建议私钥备份到密码管理器。
- 首次启用 updater 后，0.3.1 及更早版本无法自动升级到 0.4.0（它们没有 updater plugin）。用户需手动下载一次 0.4.0，之后自动更新可用。这是一次性成本。
- GitHub Releases 在某些网络环境（如中国大陆）访问不稳定。0.4.0 不做镜像，后续版本可评估加镜像 endpoint。
- 启动静默检查增加一次网络请求，可通过设置关闭。

## 实施边界

### 密钥管理

- 维护者本地执行 `npm run tauri signer generate -- -w ~/.tauri/murasaki-updater.key` 生成密钥对。
- 私钥密码另存。
- 私钥内容 + 密码录入 GitHub Actions secrets：`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 公钥写入 `tauri.conf.json` 的 `plugins.updater.pubkey`，提交到仓库。

### 文件改动

- `src-tauri/Cargo.toml` —— 加 `tauri-plugin-updater` 依赖。
- `src-tauri/src/lib.rs` —— `.plugin(tauri_plugin_updater::Builder::new().build())`。
- `src-tauri/tauri.conf.json` —— `plugins.updater` 配置块。
- `src-tauri/Cargo.toml` / `package.json` —— 前端加 `@tauri-apps/plugin-updater`。
- 新建 `src/composables/useUpdater.ts` —— 封装 check / download / install / restart。
- 新建 `src/components/UpdateDialog.vue` —— 自定义更新提示对话框。
- 改 `src-tauri/src/commands/menu.rs` —— 「检查更新…」菜单项触发前端事件而非占位提示。
- 改 `src/composables/useCommands.ts` —— 处理 `check-updates` 命令调用 `useUpdater.check()`。
- 改 `.github/workflows/release.yml` —— build job env 加 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- `src/types.ts` / 设置面板 —— 新增「启动时检查更新」开关（默认开）。

### 测试

- 本地端到端验证：发布一个 `v0.4.0-beta1` pre-release → 安装到测试机 → 推送 `v0.4.0-beta2` → 验证应用内能检查到新版本并完成更新。
- 验签失败路径：篡改 `.sig` 文件，确认客户端拒绝更新。
- 网络失败路径：断网时检查更新，确认错误提示友好。

### 范围外

- 代码签名证书采购 / 集成（#15/#16，stretch goal）。
- 更新下载进度详细显示（0.4.0 用 indeterminate）。
- 增量更新（不支持）。
- 镜像分发（后续版本评估）。
