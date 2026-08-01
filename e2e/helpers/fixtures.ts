/**
 * 测试夹具：准备工作区目录和文件
 * 每次调用 resetWorkspace 会清空并重建
 */
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve } from "node:path";

const WORKSPACE_ROOT = resolve(process.cwd(), "e2e/.workspace");

export interface FixtureFile {
  /** 相对 workspace root 的路径 */
  path: string;
  content: string;
}

/**
 * 删除目录内容（文件和子目录），但保留目录本身。
 *
 * Windows 上 murasaki.exe 进程可能持有 .workspace 目录的句柄，
 * 导致 rmSync(directory) 静默失败（不抛错但目录仍在）。
 * 但目录内的文件和子目录仍可正常删除。
 */
function deleteContents(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 目录不存在或不可读
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue; // 跳过无法 stat 的条目
    }
    if (isDir) {
      // 递归删除子目录内容，然后删除子目录本身
      deleteContents(fullPath);
      try {
        rmdirSync(fullPath);
      } catch {
        /* 子目录可能被锁定，跳过 */
      }
    } else {
      try {
        unlinkSync(fullPath);
      } catch {
        /* 文件可能被锁定，跳过 */
      }
    }
  }
}

/** 重置工作区目录，写入指定文件 */
export function resetWorkspace(files: FixtureFile[] = []): string {
  if (existsSync(WORKSPACE_ROOT)) {
    // 策略 1：尝试用 rmSync 删除整个目录（最快，大多数情况有效）
    let deleted = false;
    try {
      rmSync(WORKSPACE_ROOT, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
      deleted = !existsSync(WORKSPACE_ROOT);
    } catch {
      deleted = false;
    }

    // 策略 2：如果 rmSync 失败（目录被进程锁定），删除目录内容但保留目录本身
    if (!deleted) {
      // 重试 3 次，每次间隔 300ms
      for (let attempt = 0; attempt < 3; attempt++) {
        deleteContents(WORKSPACE_ROOT);
        // 验证：只保留空目录
        const remaining = readdirSync(WORKSPACE_ROOT);
        if (remaining.length === 0) {
          deleted = true;
          break;
        }
        // 等待 300ms 后重试
        const start = Date.now();
        while (Date.now() - start < 300) {
          /* busy wait */
        }
      }
      if (!deleted) {
        // 仍然有残留文件 — 记录警告但继续（fixture 文件会覆盖同名文件）
        const remaining = readdirSync(WORKSPACE_ROOT);
        console.warn(
          `resetWorkspace: ${remaining.length} files could not be deleted: ${remaining.join(", ")}`
        );
      }
    }
  } else {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }

  // 确保 fixture 文件存在（覆盖同名文件）
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
