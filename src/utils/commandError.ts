/**
 * Tauri 命令错误的结构化解析与文案渲染（#436）。
 *
 * Rust 侧所有命令统一返回 `{ code, params }`（见 `src-tauri/src/errors.rs`），
 * 前端按 code 走 i18n，不再匹配中文字符串。旧命令或非结构化异常退化为 `unknown`。
 */
import { i18n } from "../i18n";
import { useToastStore } from "../stores/useToastStore";

export interface CommandErrorInfo {
  /** 错误码（snake_case），未知时为 `unknown` */
  code: string;
  /** 上下文参数（path / detail 等） */
  params: Record<string, string>;
}

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
 * 可展示 detail 的错误码：io 的系统原文与非法参数的原因对用户有用。
 * `internal` 的细节是给排查用的（任务名 / 第三方库原文），直接展示只会变成噪音。
 */
function showsDetail(code: string): boolean {
  return code === "io" || code === "invalid_argument";
}

/**
 * 渲染用户可读文案：
 * - 类目文案来自 `common.error.code.*`
 * - 路径 / 细节的拼接也走 locale（`withPath` / `withDetail` / `withPathDetail`），
 *   不在代码里硬编码中文标点
 * - 非结构化错误直接展示原始信息
 */
export function formatCommandError(err: unknown): string {
  const { code, params } = parseCommandError(err);
  // 非结构化错误（旧命令 / 第三方插件 / JS 异常）没有可翻译的类别，
  // 直接展示原始信息，避免把有用的系统提示藏进「未知错误」。
  if (code === "unknown") {
    return params.detail || i18n.global.t("common.error.code.unknown");
  }
  const key = `common.error.code.${code}`;
  const message = i18n.global.te(key)
    ? i18n.global.t(key)
    : i18n.global.t("common.error.code.unknown");
  const detail = showsDetail(code) ? params.detail : undefined;

  if (params.path && detail) {
    return i18n.global.t("common.error.withPathDetail", {
      message,
      path: params.path,
      detail,
    });
  }
  if (params.path) {
    return i18n.global.t("common.error.withPath", { message, path: params.path });
  }
  if (detail) {
    return i18n.global.t("common.error.withDetail", { message, detail });
  }
  return message;
}

/** 错误提示 + 「重试」动作（文件树 / 监听 / 恢复等失败路径共用一段交互） */
export function showRetryToast(message: string, retry: () => void): void {
  useToastStore().error(message, {
    action: { label: i18n.global.t("common.retry"), onClick: retry },
  });
}
