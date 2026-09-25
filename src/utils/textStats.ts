/**
 * 状态栏文本统计纯函数（T2.1 / 口径对齐 Word / WPS）
 *
 * - 字数 `countWords`：CJK（中日韩统一表意文字 / 假名 / 谚文）逐字计数，
 *   其余语言的字母与数字连续串按「词」计数（"hello-world" 计 2 个词）。
 * - 字符数 `countChars`：不含空白字符（空格 / Tab / 换行等）的字符总数。
 *
 * 与用户可见文案一致的口径定义见 CONTEXT.md「状态栏」条目。
 */

/** CJK 字符（中日韩统一表意文字、扩展 A、兼容表意文字、假名、谚文） */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
/** 非 CJK 的「词字符」：Unicode 字母或数字 */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/;

/**
 * 字符数：不含空白字符的字符总数（按码点遍历，emoji 等代理对计 1）。
 */
export function countChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!WHITESPACE.test(ch)) count++;
  }
  return count;
}

/**
 * 字数：CJK 逐字 + 非 CJK 字母/数字连续串逐词。
 */
export function countWords(text: string): number {
  let count = 0;
  let run = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      count++;
      if (run > 0) {
        count++;
        run = 0;
      }
    } else if (WORD_CHAR.test(ch)) {
      run++;
    } else if (run > 0) {
      count++;
      run = 0;
    }
  }
  if (run > 0) count++;
  return count;
}
