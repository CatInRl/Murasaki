import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * i18n 接线守卫（issue #186）
 *
 * `locales.test.ts` 只能校验 locale JSON 之间的 key 树一致，无法发现写在 TS/Vue
 * 里的中文字面量。本测试静态扫描用户可见反馈入口（`dialog.*` / `toast.*` 调用），
 * 一旦参数里出现 CJK 字面量就失败，强制新增文案走 i18n。
 *
 * 允许的例外：调用参数中不含 CJK 的情况天然通过，无需白名单。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");

/** 扫描目录（相对 src/），覆盖所有用户可见反馈的调用点 */
const SCAN_DIRS = ["composables", "components", "stores", "settings"];

/** 反馈入口：dialog.* / toast.* 调用 */
const FEEDBACK_CALL_RE = /\b(dialog|toast)\.([A-Za-z]+)\s*\(/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export interface HardcodedHit {
  /** 1-based 行号 */
  line: number;
  /** 调用参数片段（截断） */
  snippet: string;
}

/**
 * 从源码中找出「调用参数含 CJK 字面量」的 dialog.* / toast.* 调用。
 * 通过括号配对提取完整实参文本（支持跨行调用），字符串内的括号不计入配对。
 */
export function findHardcodedFeedbackText(source: string): HardcodedHit[] {
  const hits: HardcodedHit[] = [];
  for (const match of source.matchAll(FEEDBACK_CALL_RE)) {
    const openIdx = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let i = openIdx;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const args = source.slice(openIdx + 1, i);
    if (CJK_RE.test(args)) {
      hits.push({
        line: source.slice(0, openIdx).split("\n").length,
        snippet: args.trim().replace(/\s+/g, " ").slice(0, 80),
      });
    }
  }
  return hits;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|vue)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("i18n 接线守卫：dialog/toast 调用不得硬编码中文", () => {
  const files = SCAN_DIRS.flatMap((d) => collectSourceFiles(join(SRC_ROOT, d)));

  it("扫描范围非空（防止目录改名后守卫静默失效）", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("所有 dialog.* / toast.* 调用参数均为 i18n（无 CJK 字面量）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const hit of findHardcodedFeedbackText(source)) {
        offenders.push(
          `${relative(SRC_ROOT, file).replace(/\\/g, "/")}:${hit.line} → ${hit.snippet}`
        );
      }
    }
    expect(offenders, `发现硬编码中文的用户可见文案：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("守卫本身能识别硬编码（样例验证）", () => {
    const bad = `
      const x = dialog.alert({ message: "请先打开一个工作区" });
      toast.error(\`保存失败: \${err}\`);
      dialog.confirm({
        message: t("common.ok"),
      });
    `;
    const hits = findHardcodedFeedbackText(bad);
    expect(hits).toHaveLength(2);
    expect(hits[0].snippet).toContain("请先打开一个工作区");

    const good = `
      dialog.alert({ message: t("common.error.openWorkspaceFirst") });
      toast.error(t("common.error.saveFailed", { error: err }));
    `;
    expect(findHardcodedFeedbackText(good)).toEqual([]);
  });
});
