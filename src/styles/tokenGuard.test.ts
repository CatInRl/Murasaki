import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * 设计 token 守卫（issue #296）
 *
 * 背景：本轮修掉的两个 bug —— `--murasaki-error` / `--murasaki-surface-muted` 都不存在，
 * 却带着 fallback，于是「变量名写错 → fallback 恒生效 → 静默用错色」没有任何拦截。
 * 本测试像 i18n 接线守卫那样静态扫描 `src/**`：凡出现引用 `--murasaki-*` 却未在
 * `theme.css` 定义的名字即失败。
 *
 * 反向（已定义但全仓零引用）只列出、不断言 —— 避免误伤预留 token。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");
const THEME_CSS_PATH = join(HERE, "theme.css");

/** 完整 token 名（段间以单个 `-` 连接，且不以 `-` 结尾） */
const TOKEN_NAME = "--murasaki-[a-z0-9]+(?:-[a-z0-9]+)*";
/**
 * 任意位置出现的 token 名（引用或定义）。
 * 末尾的负向先行断言排除注释里的通配写法（`--murasaki-*` / `--murasaki-purple-*`），
 * 否则会把 `--murasaki-purple-*` 截成不存在的 `--murasaki-purple` 造成误报。
 */
const TOKEN_NAME_RE = new RegExp(`${TOKEN_NAME}(?![a-z0-9*-])`, "g");
/** 定义位置：名字后紧跟冒号（`--murasaki-x: ...`） */
const TOKEN_DEF_RE = new RegExp(`(${TOKEN_NAME})\\s*:`, "g");

/** 从 CSS 文本抽出**定义集合**（只认 `name:` 形式，`var(--name)` 不算定义） */
export function extractDefinedTokens(css: string): Set<string> {
  const defined = new Set<string>();
  for (const match of css.matchAll(TOKEN_DEF_RE)) {
    defined.add(match[1]);
  }
  return defined;
}

/** 从任意源码文本抽出**引用集合**（所有 `--murasaki-*` 出现处，含定义行本身） */
export function extractReferencedTokens(source: string): Set<string> {
  const refs = new Set<string>();
  for (const match of source.matchAll(TOKEN_NAME_RE)) {
    refs.add(match[0]);
  }
  return refs;
}

/** 找出引用了但未定义的 token（跨 `src/**` 的 `.css` / `.vue` / `.ts`） */
export function findUndefinedTokens(source: string, defined: Set<string>): string[] {
  const undefinedTokens = new Set<string>();
  for (const name of extractReferencedTokens(source)) {
    if (!defined.has(name)) undefinedTokens.add(name);
  }
  return [...undefinedTokens];
}

/**
 * 收集扫描目标：`src/**` 的 `.css` / `.vue` / `.ts`。
 * 排除 `*.test.ts` / `*.spec.ts` —— 测试里会出现「故意写错的变量名」作样例，
 * 以及断言文案里的 token 名，纳入扫描会自指误报。
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (
      /\.(css|vue|ts)$/.test(entry) &&
      !/\.(test|spec)\.ts$/.test(entry)
    ) {
      files.push(full);
    }
  }
  return files;
}

describe("设计 token 守卫：引用的 --murasaki-* 必须在 theme.css 定义", () => {
  const defined = extractDefinedTokens(readFileSync(THEME_CSS_PATH, "utf8"));
  const files = collectSourceFiles(SRC_ROOT);

  it("扫描范围非空（防止目录改名后守卫静默失效）", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("theme.css 的定义集合非空", () => {
    expect(defined.size).toBeGreaterThan(30);
  });

  it("src/** 中不存在「引用了但未定义」的 --murasaki-* token", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const name of findUndefinedTokens(source, defined)) {
        offenders.push(`${relative(SRC_ROOT, file).replace(/\\/g, "/")} → ${name}`);
      }
    }
    expect(
      offenders,
      `发现引用了但未定义的 --murasaki-* token：\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("反向：列出「已定义但全仓零引用」的 token（仅记录，不断言）", () => {
    const referenced = new Set<string>();
    for (const file of files) {
      for (const name of extractReferencedTokens(readFileSync(file, "utf8"))) {
        referenced.add(name);
      }
    }
    const unreferenced = [...defined].filter((name) => !referenced.has(name));
    if (unreferenced.length > 0) {
      console.info(`[tokenGuard] 已定义但零引用的 token（${unreferenced.length}）：\n${unreferenced.join("\n")}`);
    }
  });

  it("守卫本身能识别未定义 token（样例验证）", () => {
    const bad = `:root { --murasaki-real: #9333ea; }\n` +
      `.x { color: var(--murasaki-real); background: var(--murasaki-does-not-exist); }`;
    const defs = extractDefinedTokens(bad);
    expect(defs.has("--murasaki-real")).toBe(true);
    expect(findUndefinedTokens(bad, defs)).toEqual(["--murasaki-does-not-exist"]);

    const good = `:root { --murasaki-real: #9333ea; }\n.x { color: var(--murasaki-real); }`;
    expect(findUndefinedTokens(good, extractDefinedTokens(good))).toEqual([]);
  });
});
