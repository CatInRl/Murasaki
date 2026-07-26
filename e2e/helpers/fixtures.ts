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
  if (existsSync(WORKSPACE_ROOT)) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
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
