/**
 * HTML 导出 E2E 测试（覆盖 H10）
 *
 * 验证：
 * - H10a: exportHtml 生成完整 HTML 字符串（含 <!DOCTYPE html>、<style>、markdown-body）
 * - H10b: 当前主题 CSS 内嵌到 <style> 标签
 * - H10c: 本地图片转 Base64 data URI 内嵌
 * - H10d: 写入磁盘后文件可被读取
 *
 * 由于 Tauri save dialog 无法在 E2E 中触发，直接调用 exportHtml composable。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  waitForPinia,
  dismissAllDialogs,
  ensureSplitMode,
  resetPersistenceSettings,
} from "../helpers/store";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

/** 调用前端 exportHtml composable */
async function callExportHtml(
  browser: Browser,
  source: string,
  theme: string,
  workspacePath: string | null,
  filePath: string | null
): Promise<string> {
  const result = await browser.executeAsync(
    (src: string, t: string, ws: string | null, fp: string | null, done: (res: unknown) => void) => {
      const fn = (window as any).__exportHtml__;
      if (!fn) {
        done({ ok: false, error: "window.__exportHtml__ not exposed" });
        return;
      }
      try {
        fn({ source: src, theme: t, workspacePath: ws, filePath: fp })
          .then((html: string) => done({ ok: true, html }))
          .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
      } catch (err: unknown) {
        done({ ok: false, error: err ? String(err) : null });
      }
    },
    source,
    theme,
    workspacePath,
    filePath
  );
  if (!(result as any).ok) {
    throw new Error(`exportHtml failed: ${(result as any).error}`);
  }
  return (result as any).html as string;
}

describe("HTML 导出", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    wsPath = resetWorkspace(defaultFixtureFiles());
    try {
      await closeAllTabs(browser);
    } catch {
      /* ignore */
    }
    try {
      await closeWorkspace(browser);
    } catch {
      /* ignore */
    }
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await dismissAllDialogs(browser);
    await ensureSplitMode(browser);
  });

  it("exportHtml 生成完整 HTML 字符串（DOCTYPE + style + markdown-body）", async () => {
    const source = "# 测试标题\n\n这是 **加粗** 文本。\n";
    const html = await callExportHtml(browser, source, "murasaki", wsPath, null);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<style>");
    expect(html).toContain("markdown-body");
    // markdown-it 渲染：# 测试标题 → <h1 ...>测试标题</h1>
    // （attachSourceLinePlugin 给块级元素加 data-source-line 属性，断言用宽松匹配）
    expect(html).toMatch(/<h1[^>]*>测试标题<\/h1>/);
    // 加粗渲染
    expect(html).toContain("<strong>加粗</strong>");
  });

  it("HTML 内嵌主题 CSS（github 主题）", async () => {
    const source = "# Title\n\nText.\n";
    const html = await callExportHtml(browser, source, "github", wsPath, null);

    // github 主题 CSS 应在 <style> 内
    expect(html).toContain('data-md-theme="github"');
    // markdown-content.css 中的样式应被内嵌
    // 通过检查 .markdown-body 选择器存在
    expect(html).toContain(".markdown-body");
  });

  it("HTML 内嵌 night 主题（深色）", async () => {
    const source = "# Night\n\n内容。\n";
    const html = await callExportHtml(browser, source, "night", wsPath, null);

    expect(html).toContain('data-md-theme="night"');
  });

  it("本地图片转 Base64 data URI 内嵌", async () => {
    // 创建一个最小的 PNG 文件（1x1 透明像素）
    const pngPath = resolve(wsPath, "test-image.png");
    // 1x1 透明 PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    writeFileSync(pngPath, pngBuffer);

    // 创建引用该图片的 md 文件
    const mdPath = resolve(wsPath, "image-test.md");
    writeFileSync(mdPath, "# 图片测试\n\n![测试图片](./test-image.png)\n", "utf-8");

    const source = readFileSync(mdPath, "utf-8");
    const html = await callExportHtml(
      browser,
      source,
      "murasaki",
      wsPath,
      mdPath.replace(/\\/g, "/")
    );

    // 应将 <img src="./test-image.png"> 替换为 <img src="data:image/png;base64,...">
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain(pngBase64);
    // 不应残留相对路径
    expect(html).not.toContain('./test-image.png');
  });

  it("导出包含 front-matter 卡片", async () => {
    const source = "---\ntitle: 测试文档\ntags: [a, b]\n---\n\n# 正文标题\n";
    const html = await callExportHtml(browser, source, "murasaki", wsPath, null);

    // front-matter 应被渲染为卡片
    expect(html).toContain("front-matter");
    expect(html).toContain("测试文档");
  });

  it("导出代码块带 Shiki 高亮", async () => {
    const source = "```js\nconst x = 1;\n```\n";
    const html = await callExportHtml(browser, source, "github", wsPath, null);

    // Shiki 高亮会生成带 class 的 <pre><code>
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    // shiki 输出会有 style 或 class 标记的颜色
    expect(html).toMatch(/shiki|color:|style=/);
  });

  it("通过 Tauri write_text_file 写入磁盘后可读取", async () => {
    const source = "# 磁盘写入测试\n\n内容。\n";
    const html = await callExportHtml(browser, source, "murasaki", wsPath, null);

    // 写入磁盘
    const outPath = resolve(wsPath, "exported.html");
    const result = await browser.executeAsync(
      (path: string, content: string, done: (res: unknown) => void) => {
        // @ts-ignore
        window.__TAURI_INTERNALS__.invoke("write_text_file", { path, content })
          .then(() => done({ ok: true }))
          .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
      },
      outPath.replace(/\\/g, "/"),
      html
    );
    expect(result as any).toMatchObject({ ok: true });

    // 验证文件存在并可读取
    expect(existsSync(outPath)).toBe(true);
    const fileContent = readFileSync(outPath, "utf-8");
    expect(fileContent).toBe(html);
    // markdown 已被渲染为 <h1>，不应残留 # 源码标记
    expect(fileContent).toMatch(/<h1[^>]*>磁盘写入测试<\/h1>/);
  });
});
