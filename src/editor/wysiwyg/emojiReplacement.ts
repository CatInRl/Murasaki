/**
 * T6.1 (issue #99) — Emoji 短代码源码替换。
 *
 * WYSIWYG 模式下，光标离开当前段时，段内 `:shortcode:` 被替换为实际 emoji 字符
 * 写入源码（非仅视觉隐藏）。源码模式/分屏模式不触发替换。
 *
 * 本文件提供纯函数：给定文档文本 + 段范围 + 代码范围 → 返回需替换的 shortcode 列表。
 * ViewPlugin（wysiwygPlugin.ts）监听光标离段事件，调用本函数后 dispatch changes。
 *
 * 复用 markdown-it-emoji 的完整 shortcode → unicode 映射（与渲染管线一致）。
 */
import emojiData from "markdown-it-emoji/lib/data/full.mjs";

/** shortcode 正则：`:name:`，name 含小写字母/数字/下划线/加号/减号/连字符 */
const EMOJI_SHORTCODE_RE = /:([a-z0-9_+-]+):/g;

/** 替换项：将 [from, to] 的 `:shortcode:` 文本替换为 emoji 字符 */
export interface EmojiReplacement {
  from: number;
  to: number;
  /** 实际 emoji unicode 字符 */
  emoji: string;
  /** shortcode（不含冒号） */
  shortcode: string;
}

/** 判断 [from, to] 是否完全落在任一代码范围内 */
function inAnyCodeRange(
  from: number,
  to: number,
  codeRanges: Array<{ from: number; to: number }>
): boolean {
  for (const r of codeRanges) {
    if (from >= r.from && to <= r.to) return true;
  }
  return false;
}

/**
 * 扫描文档 [paraFrom, paraTo] 范围内的 emoji shortcode，返回有效替换项。
 *
 * 规则：
 * - shortcode 必须完全落在 [paraFrom, paraTo] 内（不替换跨段边界的半截 shortcode）
 * - 跳过代码范围（代码块 / 行内代码）内的匹配
 * - 跳过未知 shortcode（emojiData 中无映射）
 * - 返回结果按 from 升序
 *
 * @param doc 完整文档文本
 * @param paraFrom 段起始位置（含）
 * @param paraTo 段结束位置（不含）
 * @param codeRanges 代码范围列表（FencedCode/CodeBlock/InlineCode）
 */
export function findEmojiShortcodesInRange(
  doc: string,
  paraFrom: number,
  paraTo: number,
  codeRanges: Array<{ from: number; to: number }>
): EmojiReplacement[] {
  const result: EmojiReplacement[] = [];
  const data = emojiData as Record<string, string>;
  EMOJI_SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_SHORTCODE_RE.exec(doc)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    // 必须完全落在段范围内
    if (from < paraFrom || to > paraTo) continue;
    const shortcode = m[1];
    const emoji = data[shortcode];
    if (!emoji) continue; // 未知 shortcode
    if (inAnyCodeRange(from, to, codeRanges)) continue;
    result.push({ from, to, emoji, shortcode });
  }
  return result;
}
