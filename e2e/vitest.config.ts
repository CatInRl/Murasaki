import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const e2eRoot = dirname(fileURLToPath(import.meta.url));

/**
 * E2E 测试配置
 * - 串行执行（避免多个 Tauri 实例同时启动）：`fileParallelism: false` +
 *   `isolate: false` 让所有 spec 在同一个 fork 里依次跑
 * - 超时放宽到 60s（应用冷启动慢）
 * - 通过 globalSetup 启动 tauri-driver，由各测试文件自行创建 session
 * - root 指向 e2e/ 目录，使 include/specs 相对解析
 * - env 注入 MURASAKI_E2E_API_KEY 供 agent 全功能测试使用
 *
 * 注意：原写法 `poolOptions.forks.singleFork` 在 Vitest 4 已被移除（旧写法只会打印
 * 弃用警告并被忽略，串行保障会静默失效），等价顶层选项是 `fileParallelism: false`。
 */
export default defineConfig({
  test: {
    root: e2eRoot,
    include: ["specs/**/*.spec.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    globalSetup: resolve(e2eRoot, "setup.ts"),
    globals: true,
    isolate: false,
    env: {
      // 从父进程继承 MURASAKI_E2E_API_KEY（若未设置则为空字符串，agent LLM 测试将跳过）
      MURASAKI_E2E_API_KEY: process.env.MURASAKI_E2E_API_KEY ?? "",
    },
  }
});
