import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.ts", "src-tauri/src/**/*.{test,spec}.rs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 只统计测试真正加载过的文件：新增未测文件不会把全局阈值拉低，
      // 但已覆盖代码的覆盖率不能再退化。
      exclude: [
        "src/**/*.{test,spec}.ts",
        "src/**/*.d.ts",
        "src/test/**",
        "src/main.ts",
        "src/settings/main.ts",
      ],
      // 覆盖率基线（#445）：低于该值直接失败，防止回退。
      // 数值取 2026-10-18 实测值向下取整，新增代码应尽量补测而不是下调阈值。
      thresholds: {
        statements: 72,
        branches: 67,
        functions: 65,
        lines: 73,
      },
    },
  },
});
