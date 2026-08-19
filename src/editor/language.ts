/**
 * CodeMirror 语言映射（issue 0.x：支持非 md 文本/代码文件高亮）
 *
 * 基于 @codemirror/language-data 的 languages 注册表 + LanguageDescription.matchFilename
 * 按文件名/扩展名解析合适的语言描述，供源码编辑器在非 markdown 文件上启用对应高亮。
 */
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";

/**
 * 每个 runtime 只解析一次的对象：filename → 命中的 LanguageDescription 缓存。
 * 若命中则直接复用其 support（懒加载的语言会在首次取用时加载）。
 */
const descCache = new Map<string, LanguageDescription | undefined>();

/**
 * 根据文件名（含扩展名，如 "config.yaml"）解析对应的 CodeMirror 语言描述。
 * 找不到匹配返回 undefined（调用方回退到纯文本/无高亮）。
 */
export function resolveLanguageDescription(filename: string): LanguageDescription | undefined {
  const cached = descCache.get(filename);
  if (cached !== undefined) return cached;
  const desc = LanguageDescription.matchFilename(languages, filename) ?? undefined;
  descCache.set(filename, desc);
  return desc;
}

/**
 * 根据文件名取得可用于编辑器扩展的语言描述。
 * 这是动态解析（惰性），供 SourceEditor 在构建/重配 extensions 时使用。
 */
export function languageForFile(filename: string): LanguageDescription | undefined {
  return resolveLanguageDescription(filename);
}