/**
 * Tauri 命令错误的结构化解析与文案渲染（#436）。
 *
 * Rust 侧所有命令统一返回 `{ code, params }`（见 `src-tauri/src/errors.rs`），
 * 前端按 code 走 i18n，不再匹配中文字符串。旧命令或非结构化异常退化为 `unknown`。
 */
import { i18n } from "../i18n";

export interface CommandErrorInfo {
  /** 错误码（snake_case），未知时为 `unknown` */
  code: string;
  /** 上下文参数（path / detail / to 等） */
  params: Record<string, string>;
}

/** 与 Rust `ErrorCode` 一一对应；新增错误码时同步这里与三套 locale */
const KNOWN_CODES = [
  "not_found",
  "not_a_directory",
  "not_a_file",
  "already_exists",
  "permission_denied",
  "outside_workspace",
  "invalid_argument",
  "unsupported",
  "timeout",
  "internal",
  "io",
] as const;

const KNOWN = new Set<string>(KNOWN_CODES);

/** 把 invoke 的拒绝值解析为结构化错误（非结构化 → unknown + detail） */
export function parseCommandError(err: unknown): CommandErrorInfo {
  if (typeof err === "object" && err !== null) {
    const record = err as { code?: unknown; params?: unknown };
    if (typeof record.code === "string") {
      const rawParams =
        typeof record.params === "object" && record.params !== null
          ? (record.params as Record<string, unknown>)
          : {};
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawParams)) {
        params[key] = String(value);
      }
      return { code: record.code, params };
    }
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { code: "unknown", params: detail ? { detail } : {} };
}

/**
 * 渲染用户可读文案：
 * - 类目文案来自 `common.error.code.*`
 * - 有 `path` 时追加「：<路径>」
 * - `io` / `internal` 有 `detail` 时追加括号说明（系统原文，不翻译）
 * - 非结构化错误直接展示原始信息
 */
export function formatCommandError(err: unknown): string {
  const { code, params } = parseCommandError(err);
  // 非结构化错误（旧命令 / 第三方插件 / JS 异常）没有可翻译的类别，
  // 直接展示原始信息，避免把有用的系统提示藏进「未知错误」。
  if (code === "unknown") {
    return params.detail || i18n.global.t("common.error.code.unknown");
  }
  const key = `common.error.code.${KNOWN.has(code) ? code : "unknown"}`;
  let text = i18n.global.t(key);
  if (params.path) text += `：${params.path}`;
  if (params.detail && (code === "io" || code === "internal")) {
    text += `（${params.detail}）`;
  }
  return text;
}
