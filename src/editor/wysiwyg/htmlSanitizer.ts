/**
 * T6.4 (issue #103) — 内联 HTML 安全渲染。
 *
 * 通过 DOMPurify 净化 markdown-it 输出的 HTML 字符串：
 * - 清除 XSS payload：<script> / <iframe> / <object> / <embed> / <form> /
 *   on* 事件属性 / javascript: URL / SVG <script> / IE 条件注释
 * - 保留白名单标签与属性：span/div/p/strong/em/code/mark/sub/sup/h1-h6/
 *   blockquote/pre/ul/li/a/img/table 等 + style/class/title/alt/href/src
 *
 * 集成位置（防御纵深）：
 * - useMarkdownRenderer.render() —— 预览 / 导出 / WYSIWYG 表格 widget 共享入口
 * - wysiwygPlugin.HtmlWidget.toDOM() —— WYSIWYG 模式 HTML 块 widget 渲染前再次净化
 *
 * 为什么在多处净化？
 * - render() 是统一入口，覆盖 99% 场景（预览/导出/表格 widget）
 * - HtmlWidget 单独净化是 belt-and-suspenders：widget 可能直接接收原始 doc 文本，
 *   绕过 render()，故在注入 innerHTML 前再次净化确保安全
 *
 * DOMPurify 默认配置已足够：
 * - 默认白名单覆盖常见格式标签 + 块级标签 + 表格结构
 * - 默认禁用脚本/iframe/object/embed/form
 * - 默认清除 on* 事件属性与 javascript: 协议
 * - 默认保留 style/class/id/title/alt/href/src 属性
 *
 * 不使用 ALLOWED_TAGS / ALLOWED_ATTR 显式白名单：
 * - DOMPurify 默认白名单已对齐 CommonMark + GFM 渲染需求
 * - 显式白名单易遗漏（如 mathjax/katex 输出包含自定义标签），反而引入风险
 * - 如未来需要收紧（如禁用 style），可在此处添加 ADD_ATTR/FORBID_ATTR 配置
 */
import DOMPurify from "dompurify";

/**
 * 净化 HTML 字符串，清除 XSS payload 并保留白名单标签。
 *
 * @param html 待净化的 HTML 字符串（通常是 markdown-it 渲染输出）
 * @returns 净化后的 HTML 字符串，可直接用于 innerHTML 赋值
 */
export function sanitizeInlineHtml(html: string): string {
  if (!html) return "";
  // DOMPurify 默认配置已清除 script/iframe/object/embed 与 on*/javascript: 等 XSS 向量
  // 此处额外显式禁用表单相关标签：markdown 渲染输出不应包含表单元素，
  // 防止钓鱼表单（<form action="https://evil.com">）混入文档。
  // 注意：不禁用 <input> —— task list 复选框依赖 <input type="checkbox">，
  // DOMPurify 默认会清除 on* / javascript: 等危险属性，input 本身安全。
  return DOMPurify.sanitize(html, {
    // 同步模式（默认即同步，显式标注以避免歧义）
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // 禁用表单相关标签（防钓鱼 + markdown 渲染无表单需求）
    // 不含 input：task list 复选框需要 <input type="checkbox">
    FORBID_TAGS: ["form", "button", "select", "textarea", "fieldset", "legend", "option", "optgroup"],
    // 允许 SVG <script> 被 DOMPurify 自动移除（默认行为）
    // 保留 <a href> 与 <img src>，DOMPurify 默认会清除 javascript: 协议
    // 允许 data: URI（Base64 图片合法）
    ALLOW_DATA_ATTR: true,
  }) as string;
}

/**
 * DOMPurify 全局配置（一次性，模块加载时执行）。
 *
 * 可在此添加 hook 自定义净化行为，例如：
 * - 禁用特定标签：DOMPurify.addHook('uponSanitizeElement', ...)
 * - 限制特定属性：DOMPurify.addHook('uponSanitizeAttribute', ...)
 *
 * 当前使用默认配置，预留扩展点。
 */
