import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri 在 Windows 用 WebView2（Chromium），macOS / Linux 用系统 WebKit（WKWebView /
    // WebKitGTK）。这里显式固定 target：不写就会吃 Vite 默认值，而默认基线随 Vite 大版本
    // 一路上抬（v6 ≈ Chrome 87 / Safari 14 → v8 ≈ Chrome 111 / Safari 16.4），旧 WebKit 上
    // 可能出现语法或渲染问题，且在 Windows 开发机上不会暴露。取值按 Tauri 官方 Vite 指南。
    //
    // 注意：直接 `npm run build`（例如 CI）时 TAURI_ENV_PLATFORM 未设置，会落到 safari13
    // 分支 —— 更保守，符合预期；只有 `tauri build` 才会让 Windows 用 chrome105。
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
}));
