import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import zhCN from "./zh-CN";
import en from "./en";
import ja from "./ja";

/**
 * i18n key 可解析性守卫
 *
 * `locales.test.ts` 校验的是 locale JSON **之间**的 key 树一致，`i18nHardcodedGuard.test.ts`
 * 拦的是**硬编码文案**；两者都发现不了「key 写错/漏写模块前缀」—— 那种情况下 vue-i18n 只在
 * 控制台 warn，界面上**原样显示 key 本身**（`toast.cannotOpenFile`），静默到用户抱怨为止。
 * 本测试静态扫描 `src/**` 里 `t("...")` / `$t("...")` 的**字面量** key，逐个在三种语言里解析，
 * 解析不到即失败（动态 key 如 `` t(`menu.${id}`) `` 无法静态判断，跳过）。
 *
 * 已按此修掉两处：`TreeNode.vue` 的 `toast.cannotOpenFile`（#307 引入，含本 PR 的
 * `common.toast.unsupportedDropFiles`）。同类守卫的思路见 `i18nHardcodedGuard.test.ts`（#186）
 * 与 `styles/tokenGuard.test.ts`（#296）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");

/** 三种语言的消息树（结构即 `locales/{locale}/index.ts` 的模块聚合） */
const TREES: Record<string, unknown> = { "zh-CN": zhCN, en, ja };

/** `t("a.b")` / `$t('a.b')` 形式的字面量 key；要求 key 以字母开头，避免匹配到 `t(...)` 之外的调用 */
const KEY_CALL_RE = /(?<![\w.$])(?:\$t|t)\(\s*["']([A-Za-z][\w.]*)["']/g;

export function findI18nKeys(source: string): string[] {
  return [...source.matchAll(KEY_CALL_RE)].map((m) => m[1]);
}

function resolveKey(tree: unknown, key: string): boolean {
  let cur: unknown = tree;
  for (const part of key.split(".")) {
    if (typeof cur !== "object" || cur === null) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|vue)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
  }
  return out;
}

describe("findI18nKeys", () => {
  it("抓取字面量 key（含 $t / 单双引号）", () => {
    expect(findI18nKeys(`t("common.save")`)).toEqual(["common.save"]);
    expect(findI18nKeys(`$t('menu.view')`)).toEqual(["menu.view"]);
  });

  it("跳过动态 key 与非 t 调用", () => {
    expect(findI18nKeys("t(`menu.${id}`)")).toEqual([]);
    expect(findI18nKeys("format(value)")).toEqual([]);
  });
});

describe("i18n key 守卫", () => {
  it("src 里所有字面量 t(\"...\") key 都能在三种语言里解析", () => {
    const broken: string[] = [];
    for (const path of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, path).replace(/\\/g, "/");
      for (const key of findI18nKeys(readFileSync(path, "utf8"))) {
        for (const [locale, tree] of Object.entries(TREES)) {
          if (!resolveKey(tree, key)) broken.push(`${rel} → ${locale}: ${key}`);
        }
      }
    }
    expect([...new Set(broken)]).toEqual([]);
  });
});
