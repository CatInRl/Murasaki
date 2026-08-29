import { describe, it, expect } from "vitest";
import { parseTable, reflowTable, displayWidth } from "./tableReflow";

// 源示例取自 high-fi UX：补空格对齐到中文显示宽度
const source = [
  "| 功能     | 状态   | 负责人 |",
  "|----------|--------|--------|",
  "| 就地编辑 | 进行中 | UI 组   |",
  "| 行列增删 | 待办   | 引擎组 |",
].join("\n");

describe("parseTable", () => {
  it("解析合法管道表格为 cells + align（默认左对齐）", () => {
    const t = parseTable(source);
    expect(t).not.toBeNull();
    expect(t!.cells).toEqual([
      ["功能", "状态", "负责人"],
      ["就地编辑", "进行中", "UI 组"],
      ["行列增删", "待办", "引擎组"],
    ]);
    expect(t!.align).toEqual(["l", "l", "l"]);
  });

  it("识别 `:---` `:---:` `---:` 的对齐", () => {
    const t = parseTable(["| A | B | C |", "|:---|:---:|---:|", "|1|2|3|"].join("\n"));
    expect(t!.align).toEqual(["l", "c", "r"]);
  });

  it("支持无首尾管道符与可变空格", () => {
    const t = parseTable(["A | B", "---|---", "1 | 2"].join("\n"));
    expect(t!.cells).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("提取单元格后不丢失转义竖线（`\\|` → `|`）", () => {
    const t = parseTable(["| a \\| b | c |", "|---|---|", "| x | y |"].join("\n"));
    expect(t!.cells[0][0]).toBe("a | b");
  });

  it("空单元格保留为空串", () => {
    // 源：表头(0) + 分隔(跳过) + 1 数据行(1)
    const t = parseTable(["| a |  |", "|---|---|", "|  | b |"].join("\n"));
    expect(t!.cells[0][0]).toBe("a");
    expect(t!.cells[0][1]).toBe("");
    expect(t!.cells[1][0]).toBe("");
    expect(t!.cells[1][1]).toBe("b");
  });

  it("含 emoji 等非 BMP 字符不丢、不错位", () => {
    const t = parseTable(["| 表情 | 值 |", "|------|---|", "| 😀 | 1 |"].join("\n"));
    expect(t!.cells[1][0]).toBe("😀");
    expect(t!.cells[1][1]).toBe("1");
  });

  it("非表格输入返回 null", () => {
    expect(parseTable("普通段落文本")).toBeNull();
    expect(parseTable("| 单行无分隔 |")).toBeNull();
  });
});

describe("reflowTable", () => {
  /** 断言多行同列管道符垂直对齐（补空格对齐核心：按显示宽度对齐）。 */
  function expectPipeAligned(out: string) {
    // 每个内部管道符的"显示宽度位置" = 其左侧前缀的累计显示宽
    const posSets = out.split("\n").map((l) =>
      [...l.matchAll(/\|/g)].map((m) => m.index!).slice(1, -1).map((i) => displayWidth(l.slice(0, i))).join(","),
    );
    for (let i = 1; i < posSets.length; i++) {
      expect(posSets[i]).toBe(posSets[0]);
    }
  }

  it("补空格对齐：管道符在多行间垂直对齐，且往返幂等", () => {
    const t = parseTable(source)!;
    const out = reflowTable(t);
    expectPipeAligned(out);
    // 幂等：reflow(parse(out)) === out
    expect(reflowTable(parseTable(out)!)).toBe(out);
  });

  it("中文（显示宽度 2）正确参与列宽计算并对齐", () => {
    const t = parseTable(["| 列 | x |", "|---|---|", "| 字 | 值 |", "| 很长的字 | 1 |"].join("\n"))!;
    const out = reflowTable(t);
    expectPipeAligned(out);
  });

  it("序列化时把 `|` 转义为 `\\|`", () => {
    const t = parseTable(["| a | b |", "|---|---|", "| x | y |"].join("\n"))!;
    t.cells[1][0] = "x | y";
    const out = reflowTable(t);
    expect(out).toContain("| x \\| y");
  });

  it("对齐信息保留：左/中/右对应 `:---`/`:---:`/`---:` 在分隔行", () => {
    const t = parseTable(["| A | B | C |", "|:---|:---:|---:|", "|1|2|3|"].join("\n"))!;
    const sep = reflowTable(t).split("\n")[1];
    expect(sep).toContain(":---");
    expect(sep).toContain(":---:");
    expect(sep).toContain("---:");
    // 对齐在返回模型与往返后均保留
    expect(parseTable(reflowTable(t))!.align).toEqual(["l", "c", "r"]);
  });

  it("空单元格往返保持行数一致", () => {
    const t = parseTable(["| a | b |", "|---|---|", "| | |"].join("\n"))!;
    const out = reflowTable(t);
    expect(out.split("\n")).toHaveLength(3);
  });
});