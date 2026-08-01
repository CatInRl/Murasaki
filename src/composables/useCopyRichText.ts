import { exportHtml } from "./useHtmlExport";
import type { Ref } from "vue";
import type { Tab } from "../types";

/** useCopyRichText 依赖的 store/状态切片 */
export interface CopyRichTextDeps {
  /** 当前激活 tab（computed 或 getter） */
  activeTab: { value: Tab | null };
  /** 当前 Markdown 主题（与 HTML 导出共用） */
  currentTheme: Ref<string>;
  /** workspace 切片（用于解析相对图片路径） */
  workspace: {
    workspacePath: string | null;
  };
  /** toast 反馈（成功/失败提示） */
  toast: {
    success: (title: string) => void;
    error: (title: string) => void;
  };
}

/**
 * 从 exportHtml 产出的完整 HTML 中提取富文本片段（<style> + <body> 内部内容）。
 *
 * 完整 HTML 包含 `<!DOCTYPE><html><head><body>` 等结构标签，写入剪贴板时
 * 目标应用（Word/飞书等）只需片段：保留 `<style>` 块让样式生效，
 * 提取 `<body>` 内部内容作为富文本主体。
 *
 * 导出为纯函数便于单独测试。
 */
export function extractRichTextFragment(fullHtml: string): string {
  // 提取 <style>...</style> 块（保留标签）
  const styleMatch = fullHtml.match(/<style>[\s\S]*?<\/style>/);
  const style = styleMatch ? styleMatch[0] : "";

  // 提取 <body ...>内部内容</body>（不含 body 标签本身）
  const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  const body = bodyMatch ? bodyMatch[1] : fullHtml;

  return style + body;
}

/**
 * 复制为富文本：将当前 tab 渲染后的 HTML 作为富文本写入系统剪贴板。
 *
 * 复用 {@link ./useHtmlExport} 的 `exportHtml()` 管线，保证「复制富文本 = 预览外观」。
 * 写入两种 MIME：
 *  - `text/html` —— 富文本片段（含主题 CSS + body 内容），粘贴到 Word/飞书等保留格式
 *  - `text/plain` —— markdown 源码回退，粘贴到纯文本编辑器时使用
 *
 * issue #108。
 */
export function useCopyRichText(deps: CopyRichTextDeps) {
  const { activeTab, currentTheme, workspace, toast } = deps;

  async function copyRichText(): Promise<void> {
    if (!activeTab.value) {
      toast.error("请先打开一个文件");
      return;
    }
    const tab = activeTab.value;
    try {
      const fullHtml = await exportHtml({
        source: tab.content,
        theme: currentTheme.value,
        workspacePath: workspace.workspacePath ?? null,
        filePath: tab.path,
      });
      const richTextFragment = extractRichTextFragment(fullHtml);

      // ClipboardItem 同时写入 text/html + text/plain，目标应用按需取用
      const clipboardItem = new ClipboardItem({
        "text/html": new Blob([richTextFragment], { type: "text/html" }),
        "text/plain": new Blob([tab.content], { type: "text/plain" }),
      });
      await navigator.clipboard.write([clipboardItem]);
      toast.success("已复制富文本到剪贴板");
    } catch (err) {
      console.error("复制富文本失败:", err);
      toast.error(`复制富文本失败: ${err}`);
    }
  }

  return { copyRichText };
}
