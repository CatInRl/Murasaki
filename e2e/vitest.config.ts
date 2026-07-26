import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const e2eRoot = dirname(fileURLToPath(import.meta.url));

/**
 * E2E 测试配置
 * - 单 fork 串行执行（避免多个 Tauri 实例同时启动）
 * - 超时放宽到 60s（应用冷启动慢）
 * - 通过 globalSetup 启动 tauri-driver，由各测试文件自行创建 session
 * - root 指向 e2e/ 目录，使 include/specs 相对解析
 */
export default defineConfig({
  test: {
    root: e2eRoot,
    include: ["specs/**/*.spec.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true }
    },
    testTimeout: 60000,
    hookTimeout: 60000,
    globalSetup: resolve(e2eRoot, "setup.ts"),
    globals: true,
    isolate: false
  }
});
