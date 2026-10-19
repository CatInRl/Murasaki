/**
 * Markdown 渲染单测（issue #444：把 e2e/specs/markdown-render.spec.ts 下沉到 jsdom）
 *
 * 渲染链路与原 e2e 一致：`renderer.render()` 产出 HTML（含 Mermaid / PlantUML 占位、
 * 代码块占位）→ 挂到 DOM → `renderer.highlight()` 把代码块替换为 Shiki 高亮 HTML。
 * front-matter 卡片与 PreviewPane 一致，由 `renderFrontMatterCard()` 前置拼进容器。
 *
 * 覆盖：表格、KaTeX、代码块、Emoji、任务列表、front-matter 卡片、引用块、列表、
 * 链接、图片、标题层级、行内格式、综合渲染。
 *
 * jsdom 限制：Mermaid / PlantUML 无法真正渲染 SVG，这里只断言占位容器与源码；
 * SVG 渲染仍由 e2e 覆盖（另见 utils/mermaidTheme.test.ts 的 viewBox/裁剪单测）。
 * 依赖真实浏览器样式计算的用例（标题字号、列表 padding、图表描边色）未下沉。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 与 utils/imagePath.test.ts 同口径：固定 convertFileSrc，避免平台差异
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { getMarkdownRenderer } from "../composables/useMarkdownRenderer";
import { renderFrontMatterCard } from "../composables/useFrontMatter";

// 测试专用 fixture：与原 e2e 完全一致，每个用例独立、互不依赖
const FIXTURES: Record<string, string> = {
  table: `# 表格测试

| 名称 | 版本 | 状态 |
|------|------|------|
| Murasaki | 0.1.0 | 开发中 |
| Tauri | 2.x | 稳定 |
| Vue | 3.5 | 稳定 |

## 对齐方式

| 左对齐 | 居中 | 右对齐 |
|:-------|:----:|-------:|
| left   | mid  |  right |
`,
  math: `# 数学公式

## 行内公式

能量方程：$E = mc^2$

欧拉公式：$e^{i\\pi} + 1 = 0$

## 块级公式

$$
\\int_0^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$
`,
  code: `# 代码块测试

## 行内代码

使用 \`npm install\` 安装依赖，调用 \`fn(x)\` 函数。

## Rust 代码块

\`\`\`rust
fn main() {
    let x = 42;
    println!("Hello, {}!", x);
}
\`\`\`

## TypeScript 代码块

\`\`\`typescript
interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  return \`Hello, \${user.name}\`;
}
\`\`\`

## JSON 代码块

\`\`\`json
{
  "name": "murasaki",
  "version": "0.1.0"
}
\`\`\`
`,
  mermaid: `# Mermaid 图表

## 流程图

\`\`\`mermaid
graph LR
    A[开始] --> B{条件判断}
    B -->|是| C[执行操作]
    B -->|否| D[结束]
    C --> D
\`\`\`

## 时序图

\`\`\`mermaid
sequenceDiagram
    participant U as 用户
    participant E as 编辑器
    participant F as 文件系统
    U->>E: 打开文件
    E->>F: 读取文件
    F-->>E: 返回内容
    E-->>U: 显示内容
\`\`\`

## Gantt 图

\`\`\`mermaid
gantt
    title 项目进度
    dateFormat  YYYY-MM-DD
    section 阶段一
    设计 :done, des1, 2026-01-01, 7d
    编码 :active, des2, after des1, 10d
\`\`\`
`,
  plantuml: `# PlantUML 图表

\`\`\`plantuml
@startuml
Alice -> Bob: 你好
Bob --> Alice: 你好
@enduml
\`\`\`
`,
  emoji: `# Emoji 测试

## 短代码

:smile: :heart: :thumbsup: :rocket: :fire:

## 混合文本

这是一个 :tada: 庆祝消息，包含 :+1: 点赞。
`,
  tasklist: `# 任务列表

## 待办事项

- [x] 已完成项
- [ ] 未完成项
- [ ] 另一个任务

## 嵌套任务

- [x] 顶层任务
  - [ ] 子任务 A
  - [x] 子任务 B
`,
  frontmatter: `---
title: 测试文档
date: 2026-07-26
tags: [测试, 笔记, murasaki]
author: CatInRl
---

# 正文标题

正文内容。
`,
  quote: `# 引用块测试

## 简单引用

> 这是一个引用块。
> 第二行内容。

## 嵌套引用

> 外层引用
>
> > 内层引用
> >
> > 更深层

## 引用含其他语法

> 引用中含 **加粗** 和 *斜体*
>
> - 列表项 1
> - 列表项 2
`,
  list: `# 列表测试

## 无序列表

- 项目 A
- 项目 B
- 项目 C

## 有序列表

1. 第一项
2. 第二项
3. 第三项

## 嵌套列表

- 顶层 1
  - 子 1.1
  - 子 1.2
- 顶层 2
  1. 子 2.1
  2. 子 2.2

## 任务列表混合

- [ ] 任务 1
- 普通项
- [x] 任务 2
`,
  link: `# 链接测试

## 内部 .md 链接

跳转到 [笔记](notes.md) 文档。

## 外部 URL

访问 [GitHub](https://github.com/CatInRl/Murasaki) 仓库。

## 锚点链接

跳转到 [表格](#表格测试) 章节。

## 自动链接

<https://tauri.app>
`,
  image: `# 图片测试

## 相对路径图片

![占位图](assets/logo.png)

## 带标题的图片

![Murasaki 界面](assets/screenshot.png "Murasaki 截图")

## 外部 URL 图片

![外部图](https://example.com/image.png)
`,
  heading: `# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

---

## 分隔线后的内容

正文。
`,
  inline: `# 行内格式测试

**加粗文本**

*斜体文本*

***粗斜体***

~~删除线~~

\`行内代码\`

[超链接](https://example.com)

组合：**加粗 _斜体_** 文本
`,
  mixed: `# 综合文档

## 表格

| A | B |
|---|---|
| 1 | 2 |

## 公式

$E=mc^2$

## 代码

\`\`\`rust
fn main() {}
\`\`\`

## Mermaid

\`\`\`mermaid
graph LR
    A --> B
\`\`\`

## 列表

- [ ] 任务
- 项目

> 引用块

**加粗** *斜体*
`,
};

const renderer = getMarkdownRenderer();

/**
 * 渲染 fixture 并挂到 DOM（与 PreviewPane 一致：front-matter 卡片前置）。
 * 相对图片按 `/ws/render/<name>.md` 解析，与原 e2e 的 workspace 路径布局对应。
 */
function mount(name: string): HTMLElement {
  const { html, frontMatter } = renderer.render(FIXTURES[name], {
    filePath: `/ws/render/${name}.md`,
  });
  const container = document.createElement("div");
  container.className = "markdown-body";
  container.innerHTML = renderFrontMatterCard(frontMatter) + html;
  document.body.appendChild(container);
  return container;
}

/** 渲染 + 异步 Shiki 高亮（代码块用例用） */
async function mountHighlighted(name: string): Promise<HTMLElement> {
  const container = mount(name);
  await renderer.highlight(container, { theme: "murasaki" });
  return container;
}

/** 读取表格单元格的对齐方式（multimd-table 输出 inline style） */
function cellAlign(cell: Element): string {
  const declared = /text-align:\s*(left|center|right)/.exec(cell.getAttribute("style") ?? "");
  return declared?.[1] ?? cell.getAttribute("align") ?? "";
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ===== 测试组 1：表格 =====
describe("1. 表格渲染", () => {
  it("1.1 渲染 <table> 包含 thead 与 tbody", () => {
    const container = mount("table");
    expect(container.querySelectorAll("table").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("table > thead").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("table > tbody").length).toBeGreaterThanOrEqual(1);
  });

  it("1.2 表头单元格 <th> 数量正确", () => {
    const container = mount("table");
    const tables = Array.from(container.querySelectorAll("table"));
    expect(tables).toHaveLength(2);
    // 两个表格各 3 个 th
    expect(container.querySelectorAll("table thead th")).toHaveLength(6);
    expect(tables[0].querySelectorAll("thead th")).toHaveLength(3);
    expect(tables[1].querySelectorAll("thead th")).toHaveLength(3);
    expect(tables[0].querySelector("thead th")?.textContent).toBe("名称");
  });

  it("1.3 表体行数正确", () => {
    const container = mount("table");
    const firstTable = container.querySelectorAll("table")[0];
    expect(firstTable.querySelectorAll("tbody tr")).toHaveLength(3);
    const cells = Array.from(firstTable.querySelectorAll("tbody tr:first-child td")).map(
      (td) => td.textContent
    );
    expect(cells).toEqual(["Murasaki", "0.1.0", "开发中"]);
  });

  it("1.4 对齐方式属性正确（左/居中/右）", () => {
    const container = mount("table");
    const alignTable = container.querySelectorAll("table")[1];
    // 第二张表的对齐行：| left | mid | right |
    const cells = Array.from(alignTable.querySelectorAll("tbody tr:first-child td"));
    expect(cells).toHaveLength(3);
    expect(cells.map(cellAlign)).toEqual(["left", "center", "right"]);
    // 表头与数据列对齐一致
    const headers = Array.from(alignTable.querySelectorAll("thead th"));
    expect(headers.map(cellAlign)).toEqual(["left", "center", "right"]);
  });
});

// ===== 测试组 2：数学公式 =====
describe("2. 数学公式 (KaTeX)", () => {
  it("2.1 行内公式渲染为 KaTeX", () => {
    const container = mount("math");
    // KaTeX 渲染会生成 .katex 元素（2 个行内 + 2 个块级）
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
  });

  it("2.2 块级公式渲染为 display mode", () => {
    const container = mount("math");
    expect(container.querySelectorAll(".katex-display").length).toBeGreaterThanOrEqual(2);
  });

  it("2.3 公式包含 MathML 注音（.katex-mathml）", () => {
    const container = mount("math");
    expect(container.querySelectorAll(".katex-mathml").length).toBeGreaterThanOrEqual(1);
  });
});

// ===== 测试组 3：代码块 =====
describe("3. 代码块", () => {
  it("3.1 行内代码渲染为 <code>", () => {
    const container = mount("code");
    const inlineCodes = Array.from(container.querySelectorAll("p code")).map(
      (el) => el.textContent
    );
    expect(inlineCodes).toHaveLength(2);
    expect(inlineCodes).toEqual(["npm install", "fn(x)"]);
  });

  it("3.2 代码块渲染为 <pre><code>", async () => {
    const container = await mountHighlighted("code");
    expect(container.querySelectorAll("pre code").length).toBeGreaterThanOrEqual(3); // rust + ts + json
  });

  it("3.3 代码块被 Shiki 高亮（pre.shiki）且语言标签齐全", async () => {
    const container = await mountHighlighted("code");
    expect(container.querySelectorAll("pre.shiki").length).toBeGreaterThanOrEqual(3);
    const labels = Array.from(container.querySelectorAll(".code-lang-label")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["rust", "typescript", "json"]);
  });

  it("3.4 Rust 代码块包含 token 高亮 <span>，且代码文本完整", async () => {
    const container = await mountHighlighted("code");
    // Shiki 高亮会生成 <span>（不断言具体颜色，只断言结构与文本）
    expect(container.querySelectorAll("pre.shiki span").length).toBeGreaterThanOrEqual(5);
    const codeText = Array.from(container.querySelectorAll("pre.shiki code"))
      .map((el) => el.textContent)
      .join("\n");
    expect(codeText).toContain("fn main()");
    expect(codeText).toContain("interface User");
    expect(codeText).toContain('"name": "murasaki"');
  });
});

// ===== 测试组 4：Mermaid 图表（仅占位；SVG 渲染仍由 e2e 覆盖） =====
describe("4. Mermaid 图表（仅占位；SVG 渲染仍由 e2e 覆盖）", () => {
  it("4.1 三个 mermaid 块各自生成占位容器", () => {
    const container = mount("mermaid");
    expect(container.querySelectorAll(".mermaid")).toHaveLength(3);
  });

  it("4.2 流程图/时序图/Gantt 源码分别保留在占位容器中", () => {
    const container = mount("mermaid");
    const blocks = Array.from(container.querySelectorAll<HTMLElement>(".mermaid")).map(
      (el) => el.textContent ?? ""
    );
    expect(blocks[0]).toContain("graph LR");
    expect(blocks[1]).toContain("sequenceDiagram");
    expect(blocks[2]).toContain("gantt");
  });

  it("4.3 非法 mermaid 语法不抛错，仍生成占位容器", () => {
    const { html } = renderer.render("```mermaid\nthis is not valid mermaid syntax\n```", {
      filePath: "/ws/render/bad-mermaid.md",
    });
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    expect(container.querySelectorAll(".mermaid")).toHaveLength(1);
    expect(container.querySelector(".mermaid")?.textContent).toContain(
      "this is not valid mermaid syntax"
    );
  });
});

// ===== 测试组 4.5：PlantUML 图表（仅占位；SVG 渲染仍由 e2e 覆盖） =====
describe("4.5 PlantUML 图表（仅占位；SVG 渲染仍由 e2e 覆盖）", () => {
  it("生成 .plantuml-block 占位容器并保留源码", () => {
    const container = mount("plantuml");
    const blocks = container.querySelectorAll(".plantuml-block");
    expect(blocks).toHaveLength(1);
    const source = blocks[0].textContent ?? "";
    expect(source).toContain("@startuml");
    expect(source).toContain("Alice -> Bob: 你好");
    expect(source).toContain("@enduml");
  });
});

// ===== 测试组 5：Emoji =====
describe("5. Emoji 短代码", () => {
  it("5.1 短代码渲染为 Unicode emoji", () => {
    const container = mount("emoji");
    const text = container.querySelector("p")?.textContent ?? "";
    expect(text).toContain("😄");
    expect(text).toContain("❤");
    expect(text).toContain("👍");
    expect(text).toContain("🚀");
    expect(text).toContain("🔥");
    // 混合文本段
    const allText = container.textContent ?? "";
    expect(allText).toContain("🎉");
    expect(allText).toContain("👍");
  });

  it("5.2 短代码不被原样保留", () => {
    const container = mount("emoji");
    const html = container.innerHTML;
    expect(html).not.toContain(":smile:");
    expect(html).not.toContain(":heart:");
    expect(html).not.toContain(":tada:");
    expect(html).not.toContain(":+1:");
  });
});

// ===== 测试组 6：任务列表 =====
describe("6. 任务列表", () => {
  it("6.1 渲染 <input type=checkbox>", () => {
    const container = mount("tasklist");
    // 待办 3 个 + 嵌套任务 3 个（顶层任务本身也是任务项）
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(6);
  });

  it("6.2 已完成项 checkbox 为 checked", () => {
    const container = mount("tasklist");
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")
    );
    // 已完成项 / 顶层任务 / 子任务 B
    expect(boxes.filter((box) => box.checked)).toHaveLength(3);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(boxes[2].checked).toBe(false);
    expect(boxes[3].checked).toBe(true);
    expect(boxes[4].checked).toBe(false);
    expect(boxes[5].checked).toBe(true);
  });

  it("6.3 任务项 li 含 task-list-item 类与 label", () => {
    const container = mount("tasklist");
    expect(container.querySelectorAll("li.task-list-item")).toHaveLength(6);
    expect(container.querySelectorAll("li.task-list-item label").length).toBe(6);
    expect(container.querySelector("li.task-list-item")?.textContent).toContain("已完成项");
  });
});

// ===== 测试组 7：Frontmatter =====
describe("7. Frontmatter 卡片", () => {
  /** 拿到 render() 返回的 front-matter 与正文 HTML（复现 PreviewPane 的拼装） */
  function renderFrontmatterFixture(): { container: HTMLElement; frontMatter: string } {
    const { html, frontMatter } = renderer.render(FIXTURES.frontmatter, {
      filePath: "/ws/render/frontmatter.md",
    });
    const container = document.createElement("div");
    container.className = "markdown-body";
    container.innerHTML = renderFrontMatterCard(frontMatter) + html;
    document.body.appendChild(container);
    return { container, frontMatter };
  }

  it("7.1 渲染 frontmatter 为卡片元素", () => {
    const { container, frontMatter } = renderFrontmatterFixture();
    expect(frontMatter).toContain("title: 测试文档");
    expect(container.querySelector(".front-matter-card")).not.toBeNull();
    expect(container.querySelector(".fm-title")?.textContent).toBe("测试文档");
  });

  it("7.2 卡片内含 title/date/tags/author 字段", () => {
    const { container } = renderFrontmatterFixture();
    const text = container.textContent ?? "";
    expect(text).toContain("测试文档");
    // 日期可能被本地化为 "2026年7月26日"，仅检查年份与日
    expect(text).toMatch(/2026.*26/);
    expect(text).toContain("CatInRl");
    // tags 渲染为徽章
    const tags = Array.from(container.querySelectorAll(".fm-tag")).map((el) => el.textContent);
    expect(tags).toEqual(["测试", "笔记", "murasaki"]);
  });

  it("7.3 frontmatter 不会被渲染为正文表格或代码", () => {
    const { container } = renderFrontmatterFixture();
    expect(container.querySelectorAll("table")).toHaveLength(0);
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    // 正文标题照常渲染
    expect(container.querySelector("h1")?.textContent).toBe("正文标题");
  });
});

// ===== 测试组 8：引用块 =====
describe("8. 引用块", () => {
  it("8.1 简单引用渲染为 <blockquote>", () => {
    const container = mount("quote");
    expect(container.querySelectorAll("blockquote").length).toBeGreaterThanOrEqual(1);
  });

  it("8.2 嵌套引用渲染为 blockquote > blockquote", () => {
    const container = mount("quote");
    expect(container.querySelectorAll("blockquote blockquote").length).toBeGreaterThanOrEqual(1);
    // 「更深层」仍在嵌套引用内（与外层引用不串层）
    const nested = container.querySelector("blockquote blockquote");
    expect(nested?.textContent).toContain("内层引用");
    expect(nested?.textContent).toContain("更深层");
  });

  it("8.3 引用内可包含其他 Markdown 语法", () => {
    const container = mount("quote");
    expect(container.querySelectorAll("blockquote strong").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("blockquote ul").length).toBeGreaterThanOrEqual(1);
  });
});

// ===== 测试组 9：列表 =====
describe("9. 列表", () => {
  it("9.1 无序列表渲染为 <ul>", () => {
    const container = mount("list");
    expect(container.querySelectorAll("ul").length).toBeGreaterThanOrEqual(1);
  });

  it("9.2 有序列表渲染为 <ol>", () => {
    const container = mount("list");
    expect(container.querySelectorAll("ol").length).toBeGreaterThanOrEqual(1);
  });

  it("9.3 嵌套列表存在 ul/ol 相互嵌套结构", () => {
    const container = mount("list");
    expect(container.querySelectorAll("ul ul").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("ul ol").length).toBeGreaterThanOrEqual(1);
  });
});

// ===== 测试组 10：链接 =====
describe("10. 链接", () => {
  it("10.1 内部 .md 链接渲染为 <a href>", () => {
    const container = mount("link");
    const link = container.querySelector<HTMLAnchorElement>("a[href='notes.md']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("笔记");
  });

  it("10.2 外部 URL 链接渲染为 <a>", () => {
    const container = mount("link");
    expect(
      container.querySelectorAll("a[href='https://github.com/CatInRl/Murasaki']")
    ).toHaveLength(1);
  });

  it("10.3 自动链接渲染为 <a>", () => {
    const container = mount("link");
    const anchor = container.querySelector<HTMLAnchorElement>("a[href='https://tauri.app']");
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe("https://tauri.app");
  });

  it("10.4 锚点链接保留原 href", () => {
    const container = mount("link");
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    // markdown-it 可能对中文锚点做 URL 编码，解码后应还原为原文
    expect(anchors.map((a) => decodeURIComponent(a.getAttribute("href") ?? ""))).toContain(
      "#表格测试"
    );
  });
});

// ===== 测试组 11：图片 =====
describe("11. 图片渲染", () => {
  it("11.1 相对路径图片改写为 asset URL 的 <img>", () => {
    const container = mount("image");
    const images = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
    // ADR-0015：相对路径按 filePath 解析后经 convertFileSrc 改写为 asset 协议 URL
    const logo = images.find((img) => img.getAttribute("src")?.endsWith("logo.png"));
    expect(logo).toBeDefined();
    expect(logo?.getAttribute("src")).toBe("asset://localhost//ws/render/assets/logo.png");
    expect(logo?.getAttribute("alt")).toBe("占位图");
  });

  it("11.2 带标题图片含 title 属性", () => {
    const container = mount("image");
    const img = container.querySelector<HTMLImageElement>("img[src$='screenshot.png']");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("title")).toBe("Murasaki 截图");
    expect(img?.getAttribute("src")).toBe("asset://localhost//ws/render/assets/screenshot.png");
    expect(img?.getAttribute("alt")).toBe("Murasaki 界面");
  });

  it("11.3 外部 URL 图片渲染为 <img> 且 src 不被改写", () => {
    const container = mount("image");
    const img = container.querySelector<HTMLImageElement>(
      "img[src='https://example.com/image.png']"
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("外部图");
  });
});

// ===== 测试组 12：标题层级与分隔线 =====
describe("12. 标题与分隔线", () => {
  it("12.1 渲染 h1-h6 全部 6 个层级", () => {
    const container = mount("heading");
    for (let i = 1; i <= 6; i++) {
      expect(container.querySelectorAll(`h${i}`).length).toBeGreaterThanOrEqual(1);
    }
    expect(container.querySelector("h1")?.textContent).toBe("一级标题");
  });

  it("12.2 分隔线渲染为 <hr>", () => {
    const container = mount("heading");
    expect(container.querySelectorAll("hr").length).toBeGreaterThanOrEqual(1);
  });
});

// ===== 测试组 13：行内格式 =====
describe("13. 行内格式", () => {
  it("13.1 加粗渲染为 <strong>", () => {
    const container = mount("inline");
    expect(container.querySelectorAll("strong").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("加粗文本");
  });

  it("13.2 斜体渲染为 <em>", () => {
    const container = mount("inline");
    expect(container.querySelectorAll("em").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("斜体文本");
  });

  it("13.3 删除线渲染为 <del> 或 <s>", () => {
    const container = mount("inline");
    expect(container.querySelectorAll("del, s").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("del, s")?.textContent).toBe("删除线");
  });

  it("13.4 行内代码渲染为 <code>", () => {
    const container = mount("inline");
    expect(container.querySelectorAll("code").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("code")?.textContent).toBe("行内代码");
  });
});

// ===== 测试组 14：综合渲染 =====
describe("14. 综合渲染", () => {
  it("14.1 单文档含表格+公式+代码+mermaid+列表+引用全部正常渲染", async () => {
    const container = await mountHighlighted("mixed");

    expect(container.querySelectorAll("table").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("pre.shiki").length).toBeGreaterThanOrEqual(1);
    // Mermaid 只能断言占位（SVG 渲染仍由 e2e 覆盖）
    expect(container.querySelectorAll(".mermaid").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("blockquote").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("input[type='checkbox']").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("strong").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("em").length).toBeGreaterThanOrEqual(1);
  });
});
