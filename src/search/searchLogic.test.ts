import { describe, it, expect } from "vitest";
import { matchText, buildGroups, SEARCH_LIMITS } from "./searchLogic";
import type { BuildGroupsContext, SearchContentFileSource, SearchTabSource } from "./searchLogic";

// ===== 测试数据工厂 =====

function tab(id: string, path: string | null, title: string): SearchTabSource {
  return { id, path, title };
}

function makeCtx(overrides: Partial<BuildGroupsContext> = {}): BuildGroupsContext {
  return {
    query: "",
    hasWorkspace: true,
    tabs: [],
    recents: [],
    files: [],
    content: [],
    contentQuery: "",
    ...overrides,
  };
}

describe("matchText", () => {
  it("字符跳序命中并返回连续段", () => {
    const r = matchText("hello.txt", "ht");
    expect(r.ok).toBe(true);
    expect(r.ranges).toEqual([[0, 7]]);
  });

  it("大小写不敏感", () => {
    expect(matchText("Hello.txt", "HT").ok).toBe(true);
    expect(matchText("README.md", "readme").ok).toBe(true);
  });

  it("要求字符按序出现（逆序不命中）", () => {
    expect(matchText("hello.txt", "th").ok).toBe(false);
  });

  it("多词 AND：全部命中才 ok", () => {
    expect(matchText("hello world.md", "wo md").ok).toBe(true);
    expect(matchText("hello world.md", "wo zzz").ok).toBe(false);
  });

  it("多词各返回一段 ranges", () => {
    const r = matchText("hello world", "lo wo");
    expect(r.ok).toBe(true);
    expect(r.ranges.length).toBe(2);
    expect(r.ranges).toEqual([
      [2, 5],
      [6, 8],
    ]);
  });

  it("空查询：ok=true 且无高亮段", () => {
    const r = matchText("anything", "   ");
    expect(r.ok).toBe(true);
    expect(r.ranges).toEqual([]);
  });

  it("中文按序匹配", () => {
    const r = matchText("统一搜索条", "搜索");
    expect(r.ok).toBe(true);
    expect(r.ranges).toEqual([[2, 4]]);
  });
});

describe("buildGroups", () => {
  it("空查询默认态：仅标签 + 最近", () => {
    const ctx = makeCtx({
      tabs: [tab("t1", "/ws/a.md", "a.md")],
      recents: [{ path: "/ws/r.md", title: "r.md" }],
      files: [{ path: "/ws/f.md", title: "f.md" }],
      content: [
        { path: "/ws/c.md", title: "c.md", hits: [{ lineNumber: 1, snippet: "x", ranges: [] }] },
      ],
    });
    const groups = buildGroups(ctx);
    expect(groups.map((g) => g.kind)).toEqual(["tabs", "recent"]);
  });

  it("有查询时按 tabs > recent > files > content 分组", () => {
    const ctx = makeCtx({
      query: "md",
      contentQuery: "md",
      tabs: [tab("t1", "/ws/a.md", "a.md")],
      recents: [{ path: "/ws/r.md", title: "r.md" }],
      files: [{ path: "/ws/f.md", title: "f.md" }],
      content: [
        { path: "/ws/c.md", title: "c.md", hits: [{ lineNumber: 1, snippet: "md", ranges: [] }] },
      ],
    });
    const groups = buildGroups(ctx);
    expect(groups.map((g) => g.kind)).toEqual(["tabs", "recent", "files", "content"]);
  });

  it("无工作区降级：仅标签 + 最近", () => {
    const ctx = makeCtx({
      query: "md",
      hasWorkspace: false,
      tabs: [tab("t1", "/ws/a.md", "a.md")],
      recents: [{ path: "/ws/r.md", title: "r.md" }],
      files: [{ path: "/ws/f.md", title: "f.md" }],
      content: [
        { path: "/ws/c.md", title: "c.md", hits: [{ lineNumber: 1, snippet: "md", ranges: [] }] },
      ],
    });
    const groups = buildGroups(ctx);
    expect(groups.map((g) => g.kind)).toEqual(["tabs", "recent"]);
  });

  it("标签数量上限 5", () => {
    const tabs = Array.from({ length: 6 }, (_, i) => tab(`t${i}`, `/ws/f${i}.md`, `f${i}.md`));
    const groups = buildGroups(makeCtx({ tabs }));
    const g = groups.find((x) => x.kind === "tabs")!;
    expect(g.items.length).toBe(SEARCH_LIMITS.tabs);
  });

  it("最近文件数量上限 5", () => {
    const recents = Array.from({ length: 6 }, (_, i) => ({
      path: `/ws/r${i}.md`,
      title: `r${i}.md`,
    }));
    const groups = buildGroups(makeCtx({ recents }));
    const g = groups.find((x) => x.kind === "recent")!;
    expect(g.items.length).toBe(SEARCH_LIMITS.recent);
  });

  it("文件名数量上限 8", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `/ws/x${i}.md`,
      title: `x${i}.md`,
    }));
    const groups = buildGroups(makeCtx({ query: "x", files }));
    const g = groups.find((x) => x.kind === "files")!;
    expect(g.items.length).toBe(SEARCH_LIMITS.files);
  });

  it("文件名组：前缀命中优先 → 名称长度升序", () => {
    const files = [
      { path: "/ws/breeze.md", title: "breeze.md" },
      { path: "/ws/readme.md", title: "readme.md" },
      { path: "/ws/real.md", title: "real.md" },
    ];
    const groups = buildGroups(makeCtx({ query: "re", files }));
    const g = groups.find((x) => x.kind === "files")!;
    expect(g.items.map((i) => i.title)).toEqual(["real.md", "readme.md", "breeze.md"]);
  });

  it("匹配过滤：未命中的文件不出现", () => {
    const files = [
      { path: "/ws/alpha.md", title: "alpha.md" },
      { path: "/ws/beta.md", title: "beta.md" },
    ];
    const groups = buildGroups(makeCtx({ query: "alp", files }));
    const g = groups.find((x) => x.kind === "files")!;
    expect(g.items.map((i) => i.title)).toEqual(["alpha.md"]);
  });

  it("内容命中：每文件 ≤2 条、保留行号升序", () => {
    const content = [
      {
        path: "/ws/a.md",
        title: "a.md",
        hits: [
          { lineNumber: 1, snippet: "one", ranges: [] },
          { lineNumber: 3, snippet: "three", ranges: [] },
          { lineNumber: 5, snippet: "five", ranges: [] },
        ],
      },
    ];
    const groups = buildGroups(makeCtx({ query: "e", contentQuery: "e", content }));
    const g = groups.find((x) => x.kind === "content")!;
    expect(g.items.length).toBe(SEARCH_LIMITS.contentPerFile);
    expect(g.items.map((i) => i.lineNumber)).toEqual([1, 3]);
  });

  it("内容命中：文件数上限 5", () => {
    const content = Array.from({ length: 6 }, (_, i) => ({
      path: `/ws/c${i}.md`,
      title: `c${i}.md`,
      hits: [{ lineNumber: 1, snippet: "x", ranges: [] }],
    }));
    const groups = buildGroups(makeCtx({ query: "x", contentQuery: "x", content }));
    const g = groups.find((x) => x.kind === "content")!;
    expect(g.items.length).toBe(SEARCH_LIMITS.contentFiles);
  });

  it("内容命中：片段高亮使用 Rust 端权威 ranges", () => {
    const content: SearchContentFileSource[] = [
      {
        path: "/ws/a.md",
        title: "a.md",
        hits: [
          { lineNumber: 1, snippet: "Mura.*editor 命中", ranges: [[0, 13]] },
        ],
      },
    ];
    const groups = buildGroups(makeCtx({ query: "Mura.*editor", contentQuery: "Mura.*editor", content }));
    const g = groups.find((x) => x.kind === "content")!;
    expect(g.items[0].snippetRanges).toEqual([[0, 13]]);
  });

  it("内容命中：contentQuery 与当前查询不一致时跳过（防陈旧）", () => {
    const ctx = makeCtx({
      query: "md",
      contentQuery: "other",
      content: [
        { path: "/ws/c.md", title: "c.md", hits: [{ lineNumber: 1, snippet: "md", ranges: [] }] },
      ],
    });
    const groups = buildGroups(ctx);
    expect(groups.find((x) => x.kind === "content")).toBeUndefined();
  });

  it("同一路径不跨组重复（去重）", () => {
    const ctx = makeCtx({
      query: "a",
      contentQuery: "a",
      tabs: [tab("t1", "/ws/a.md", "a.md")],
      recents: [
        { path: "/ws/a.md", title: "a.md" },
        { path: "/ws/aa.md", title: "aa.md" },
      ],
      files: [
        { path: "/ws/a.md", title: "a.md" },
        { path: "/ws/aaa.md", title: "aaa.md" },
      ],
      content: [
        { path: "/ws/a.md", title: "a.md", hits: [{ lineNumber: 1, snippet: "a", ranges: [] }] },
      ],
    });
    const groups = buildGroups(ctx);
    const allPaths = groups.flatMap((g) => g.items.map((i) => i.path)).filter(Boolean);
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });

  it("未保存标签：path=null 进入 tabs 组且 isOpen=true", () => {
    const groups = buildGroups(makeCtx({ tabs: [tab("t1", null, "未命名")] }));
    const g = groups.find((x) => x.kind === "tabs")!;
    expect(g.items[0].path).toBeNull();
    expect(g.items[0].isOpen).toBe(true);
    expect(g.items[0].tabId).toBe("t1");
  });

  it("tabs 组条目 isOpen=true，其余组为 false", () => {
    const ctx = makeCtx({
      query: "md",
      tabs: [tab("t1", "/ws/a.md", "a.md")],
      recents: [{ path: "/ws/r.md", title: "r.md" }],
      files: [{ path: "/ws/f.md", title: "f.md" }],
    });
    const groups = buildGroups(ctx);
    for (const g of groups) {
      for (const item of g.items) {
        expect(item.isOpen).toBe(g.kind === "tabs");
      }
    }
  });
});
