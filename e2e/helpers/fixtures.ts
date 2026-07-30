/**
 * 测试夹具：准备工作区目录和文件
 * 每次调用 resetWorkspace 会清空并重建
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE_ROOT = resolve(process.cwd(), "e2e/.workspace");

export interface FixtureFile {
  /** 相对 workspace root 的路径 */
  path: string;
  content: string;
}

/** 重置工作区目录，写入指定文件 */
export function resetWorkspace(files: FixtureFile[] = []): string {
  if (existsSync(WORKSPACE_ROOT)) {
    // 前序测试的 murasaki.exe 进程可能仍持有 .workspace 目录的文件句柄
    // （file watcher 释放需要时间），导致 rmSync 遇到 EPERM。
    // 重试最多 3 次，每次失败后等待 500ms。
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // 等待 500ms 让 murasaki 释放文件句柄
        const start = Date.now();
        while (Date.now() - start < 500) { /* busy wait */ }
      }
    }
    if (lastErr) {
      // 最后一次尝试仍失败：抛出清晰错误
      throw new Error(
        `resetWorkspace: rmSync failed after 3 retries (EPERM?): ${String(lastErr)}.\n` +
        "可能原因：前序测试的 murasaki.exe 进程仍持有 .workspace 文件句柄。"
      );
    }
  }
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  for (const f of files) {
    const fullPath = resolve(WORKSPACE_ROOT, f.path);
    mkdirSync(resolve(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, f.content, "utf-8");
  }
  return WORKSPACE_ROOT;
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

/**
 * 编程式注入活动的 AI provider（用于 Agent 全功能 E2E 测试 C–G 层）
 * 返回构建好的 provider 配置信息。
 */
export async function setupActiveProvider(
  browser: import("webdriverio").Browser,
  apiKey: string,
  baseUrl = "https://api.deepseek.com",
  model = "deepseek-v4-flash"
): Promise<{ id: string; name: string }> {
  const result = await browser.executeAsync(
    (key: string, url: string, mdl: string, done: (res: unknown) => void) => {
      const pinia = (window as any).__pinia__;
      const store = pinia._s.get("aiProviders");
      const newProvider = {
        id: "", name: "E2E Test", type: "deepseek",
        baseUrl: url, model: mdl, isActive: true,
      };
      store.saveProvider(newProvider, key)
        .then((saved: any) => done({ id: saved.id, name: saved.name }))
        .catch((err: unknown) => done({ error: `saveProvider failed: ${String(err)}` }));
    },
    apiKey, baseUrl, model
  );

  if ((result as any)?.error) {
    throw new Error(`setupActiveProvider failed: ${(result as any).error}`);
  }
  return result as { id: string; name: string };
}

/** 清理活动 provider（测试隔离） */
export async function teardownActiveProvider(
  browser: import("webdriverio").Browser
): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const store = window.__pinia__._s.get("aiProviders");
    const ids = store.providers.map((p: any) => p.id);
    Promise.all(ids.map((id: string) => Promise.resolve(store.deleteProvider(id))))
      .then(() => { store.providers = []; done(null); })
      .catch((err: unknown) => done(err ? String(err) : null));
  });
}

/** 默认 fixture：3 个 .md 文件 + 1 个子目录 */
export function defaultFixtureFiles(): FixtureFile[] {
  return [
    {
      path: "intro.md",
      content: [
        "# 简介",
        "",
        "Murasaki 是一个 Markdown 编辑器。",
        "",
        "## 功能列表",
        "",
        "- [x] 编辑器",
        "- [x] 预览",
        "- [ ] 协作模式",
        "",
        "## 二级标题",
        "",
        "正文内容。",
        ""
      ].join("\n")
    },
    {
      path: "notes.md",
      content: [
        "---",
        "title: 笔记",
        "tags: [测试, 笔记]",
        "---",
        "",
        "# 笔记标题",
        "",
        "正文。"
      ].join("\n")
    },
    {
      path: "sub/deep.md",
      content: "# 子目录文件\n\n嵌套文件。"
    }
  ];
}
