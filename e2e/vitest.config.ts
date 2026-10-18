import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const e2eRoot = dirname(fileURLToPath(import.meta.url));

/**
 * 已知 flake 的隔离清单（#444）。
 *
 * 用法：`E2E_QUARANTINE=wysiwyg-full,scroll-sync`（spec 文件名，可省略 `.spec.ts`）。
 * 默认空 —— 不隔离任何用例；隔离后该文件不参与本次运行，但仍在仓库里等待修复。
 */
const quarantined = (process.env.E2E_QUARANTINE ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name) => `specs/${name.endsWith(".ts") ? name : `${name}.spec.ts`}`);

/**
 * E2E 测试配置
 * - 串行执行（避免多个 Tauri 实例同时启动）：`fileParallelism: false` +
 *   `isolate: false` 让所有 spec 在同一个 fork 里依次跑
 * - 超时放宽到 60s（应用冷启动慢）
 * - 通过 globalSetup 启动 tauri-driver，由各测试文件自行创建 session
 * - root 指向 e2e/ 目录，使 include/specs 相对解析
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
    // 已知 flake 重试一次（#444）：真实 WebView 的启动/渲染抖动不应让门禁变红
    retry: 1,
    exclude: ["**/node_modules/**", ...quarantined],
    globalSetup: resolve(e2eRoot, "setup.ts"),
    globals: true,
    isolate: false,
  }
});
