/**
 * 多语言 locale key 同步校验测试
 *
 * 强制各语言下各模块 JSON 拥有完全相同的嵌套 key 树，
 * 防止多语言 key 漂移（任一语言多 key / 少 key 都令测试失败）。
 * 以 zh-CN 为基准，所有其他语言（en/ja/…）与其逐模块对比 key 路径集合。
 * 只比较 key 路径结构，不关心翻译内容。
 */
import { describe, it, expect } from "vitest";

import common from "./zh-CN/common.json";
import menu from "./zh-CN/menu.json";
import settings from "./zh-CN/settings.json";
import editor from "./zh-CN/editor.json";
import agent from "./zh-CN/agent.json";

import enCommon from "./en/common.json";
import enMenu from "./en/menu.json";
import enSettings from "./en/settings.json";
import enEditor from "./en/editor.json";
import enAgent from "./en/agent.json";

import jaCommon from "./ja/common.json";
import jaMenu from "./ja/menu.json";
import jaSettings from "./ja/settings.json";
import jaEditor from "./ja/editor.json";
import jaAgent from "./ja/agent.json";

type Json = Record<string, unknown>;

/** 收集一个嵌套对象的扁平 key 路径集合（{a:{b:1}, c:2} → new Set(["a.b", "c"])） */
function collectKeyPaths(obj: Json, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.add(path);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const child of collectKeyPaths(value as Json, path)) {
        keys.add(child);
      }
    }
  }
  return keys;
}

/** 返回 a 有但 b 没有的 key 路径（已排序） */
function keysOnlyIn(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((k) => !b.has(k)).sort();
}

/** 各语言 → 各模块 JSON（以 zh-CN 为基准） */
const languages: Record<string, Record<string, Json>> = {
  "zh-CN": {
    common: common as Json,
    menu: menu as Json,
    settings: settings as Json,
    editor: editor as Json,
    agent: agent as Json,
  },
  en: {
    common: enCommon as Json,
    menu: enMenu as Json,
    settings: enSettings as Json,
    editor: enEditor as Json,
    agent: enAgent as Json,
  },
  ja: {
    common: jaCommon as Json,
    menu: jaMenu as Json,
    settings: jaSettings as Json,
    editor: jaEditor as Json,
    agent: jaAgent as Json,
  },
};

const baseLang = "zh-CN";
const moduleNames = ["common", "menu", "settings", "editor", "agent"] as const;

describe("locale key 同步", () => {
  for (const lang of Object.keys(languages)) {
    if (lang === baseLang) continue;
    it.each(moduleNames)("语言 %s · 模块 %s：与 zh-CN 的 key 树完全一致", (mod) => {
      const baseKeys = collectKeyPaths(languages[baseLang][mod]);
      const langKeys = collectKeyPaths(languages[lang][mod]);
      const baseOnly = keysOnlyIn(baseKeys, langKeys);
      const langOnly = keysOnlyIn(langKeys, baseKeys);

      expect(
        baseOnly.length,
        `${baseLang} 多于 ${lang} 的 key：\n${baseOnly.map((k) => `  - ${k}`).join("\n")}`
      ).toBe(0);
      expect(
        langOnly.length,
        `${lang} 多于 ${baseLang} 的 key：\n${langOnly.map((k) => `  - ${k}`).join("\n")}`
      ).toBe(0);
    });
  }
});