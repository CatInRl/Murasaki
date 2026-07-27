/**
 * Agent 文件类工具 E2E 测试（Ticket #22）
 *
 * 验收标准：
 * - list_files 返回工作区 .md 文件列表
 * - read_file 读取文件内容（4K 截断）+ 元数据
 * - search_across_files 返回命中（4K 截断）
 * - 工作区外路径返回 {ok: false, error: "path outside workspace"}，不读文件
 *
 * 不发起真实 LLM 请求：直接调用 executeTool 验证后端集成。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace } from "../helpers/store";

let browser: Browser;

describe("Agent 文件类工具", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.deleteSession();
  });

  beforeEach(async () => {
    resetWorkspace(defaultFixtureFiles());
    try {
      await closeWorkspace(browser);
    } catch {
      // 首次启动无工作区
    }
  });

  it("无工作区时 list_files 返回错误", async () => {
    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; error?: string }; summary: string }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => null,
          };
          mod.executeTool("list_files", "{}", ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; error?: string }; summary: string };

    expect(result.result.ok).toBe(false);
    expect(result.result.error).toBe("No workspace open");
  });

  it("list_files 返回工作区内 .md 文件列表", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; data?: { files?: string[] } } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("list_files", "{}", ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; data?: { files?: string[] } } };

    expect(result.result.ok).toBe(true);
    const files = result.result.data?.files ?? [];
    expect(files).toContain("intro.md");
    expect(files).toContain("notes.md");
    expect(files).toContain("sub/deep.md");
  });

  it("read_file 返回文件内容和元数据", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; data?: { docPath?: string; content?: string; contentHash?: string; contentLength?: number; truncated?: boolean } } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("read_file", JSON.stringify({ path: "intro.md" }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; data?: { docPath?: string; content?: string; contentHash?: string; contentLength?: number; truncated?: boolean } } };

    expect(result.result.ok).toBe(true);
    expect(result.result.data?.docPath).toBe("intro.md");
    expect(result.result.data?.content).toContain("简介");
    expect(result.result.data?.contentHash?.length).toBe(40);
    expect(result.result.data?.truncated).toBe(false);
  });

  it("read_file 越界路径返回 path outside workspace", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; error?: string } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("read_file", JSON.stringify({ path: "../escape.md" }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; error?: string } };

    expect(result.result.ok).toBe(false);
    expect(result.result.error).toBe("path outside workspace");
  });

  it("read_file 绝对路径返回 path outside workspace", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (wsPath: string, done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; error?: string } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          // 尝试用绝对路径访问工作区内文件
          const absPath = wsPath.replace(/\//g, "\\") + "\\intro.md";
          mod.executeTool("read_file", JSON.stringify({ path: absPath }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      },
      wsPath
    ) as { result: { ok: boolean; error?: string } };

    expect(result.result.ok).toBe(false);
    expect(result.result.error).toBe("path outside workspace");
  });

  it("search_across_files 返回命中", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; data?: { hits?: unknown[]; totalHits?: number; truncated?: boolean } } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("search_across_files", JSON.stringify({ query: "Murasaki" }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; data?: { hits?: Array<{ filePath?: string }>; totalHits?: number; truncated?: boolean } } };

    expect(result.result.ok).toBe(true);
    expect((result.result.data?.totalHits ?? 0) > 0).toBe(true);
    // intro.md 应在命中列表中
    const hitFiles = (result.result.data?.hits ?? []).map((h) => h.filePath);
    expect(hitFiles).toContain("intro.md");
  });

  it("search_across_files 支持 regex 模式", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; data?: { totalHits?: number } } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("search_across_files", JSON.stringify({ query: "Mura.*编辑器", is_regex: true }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; data?: { totalHits?: number } } };

    expect(result.result.ok).toBe(true);
    // 正则匹配应该能命中 intro.md 中的 "Murasaki 是一个 Markdown 编辑器"
    expect((result.result.data?.totalHits ?? 0) >= 1).toBe(true);
  });

  it("search_across_files 空查询返回空结果", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const workspace = pinia._s.get("workspace");
        import("/src/agent/tools.ts").then((mod: { executeTool: (name: string, args: string, ctx: unknown) => Promise<{ result: { ok: boolean; data?: { totalHits?: number; hits?: unknown[] } } }> }) => {
          const ctx = {
            getEditorView: () => null,
            getDocPath: () => null,
            getWorkspacePath: () => workspace.workspacePath,
          };
          mod.executeTool("search_across_files", JSON.stringify({ query: "" }), ctx)
            .then((res) => done(res))
            .catch((err: unknown) => done({ error: String(err) }));
        });
      }
    ) as { result: { ok: boolean; data?: { totalHits?: number; hits?: unknown[] } } };

    expect(result.result.ok).toBe(true);
    expect(result.result.data?.totalHits).toBe(0);
    expect(result.result.data?.hits).toHaveLength(0);
  });
});
