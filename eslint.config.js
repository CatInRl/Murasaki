// ESLint 扁平配置（#443）
//
// 目标是把「编译期抓不到、只能靠人眼」的问题纳入门禁：
// - eslint:recommended + typescript-eslint recommended（未使用变量、无效代码、可疑分支）
// - eslint-plugin-vue 的 flat/recommended（模板语法与 Vue 3 约定）
//
// 刻意关掉/降级的规则：
// - 排版类规则交给 Prettier，ESLint 不重复管（含 Vue 模板的换行与属性顺序）
// - no-console：本项目大量 console.warn/error 是刻意的诊断输出
// - 多词组件名：Skeleton.vue 等基础组件有意用单词名
// - no-undef：TypeScript 自己会报未定义标识符，ESLint 重复检查只会误伤 DOM 类型别名
// - e2e 的 @ts-ignore 也要求写说明（运行时钩子无法静态推导，见下）
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "coverage/**",
      ".appdata/**",
      ".scratch/**",
      "prototype-*.html",
      // 一次性诊断脚本（不参与构建与测试）
      "e2e/scripts/**",
      "e2e/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 排版交给 Prettier
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/multiline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/html-closing-bracket-spacing": "off",
      "vue/attributes-order": "off",
      // defineProps 的类型声明本身已表达可缺省性，这两条规则只带来噪音
      "vue/require-default-prop": "off",
      "vue/no-required-prop-with-default": "off",
      // 基础组件（Skeleton / ErrorState / EmptyState）有意使用单词名
      "vue/multi-word-component-names": "off",
      // 诊断日志是刻意的
      "no-console": "off",
      // #443：@ts-ignore 必须附带说明，或改用 @ts-expect-error
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": "allow-with-description",
          "ts-expect-error": "allow-with-description",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // TypeScript / Vue：未定义标识符由 tsc 负责
    files: ["**/*.ts", "**/*.tsx", "**/*.vue"],
    rules: {
      "no-undef": "off",
    },
  },
  {
    // Vue 单文件组件：<script lang="ts"> 交给 TS 解析器
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
  },
  {
    // 类型声明补齐文件（第三方插件的 ambient 声明）允许 any
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // 测试与 e2e 允许更宽松的写法（构造替身、访问 window 私有钩子）
    files: ["**/*.test.ts", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // 测试里 rethrow 只是附加诊断信息（原始错误文案已拼进 message）；
      // 且项目 tsconfig lib 为 ES2021，Error 的 cause 选项需要 ES2022
      "preserve-caught-error": "off",
    },
  }
);
