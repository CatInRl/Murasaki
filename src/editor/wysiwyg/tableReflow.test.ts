import { describe, it, expect } from "vitest";
import { parseTable, reflowTable, displayWidth, addColumn, removeColumn, addRow, removeRow, setAlignment } from "./tableReflow";

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

describe("结构性操作", () => {
  const t = parseTable([
    "| 功能 | 状态 | 负责人 |",
    "|:---|:---:|---:|",
    "| 就地编辑 | 进行中 | UI 组 |",
    "| 行列增删 | 待办 | 引擎组 |",
  ].join("\n"))!;

  it("addColumn：在中第 1 列前插入空列，对齐同步插入 l，往返有效", () => {
    const out = addColumn(t, 1);
    expect(out.align).toEqual(["l", "l", "c", "r"]);
    expect(out.cells[0]).toEqual(["功能", "", "状态", "负责人"]);
    // 不影响原模型
    expect(t.cells[0]).toEqual(["功能", "状态", "负责人"]);
    expect(parseTable(reflowTable(out))!.align).toEqual(["l", "l", "c", "r"]);
  });

  it("addColumn：越界 col 追加到末尾", () => {
    const out = addColumn(t, 99);
    expect(out.align).toHaveLength(4);
    expect(out.cells[0][3]).toBe("");
  });

  it("removeColumn：删除第 2 列，对齐收敛", () => {
    const out = removeColumn(t, 2);
    expect(out.align).toEqual(["l", "c"]);
    expect(out.cells[0]).toEqual(["功能", "状态"]);
  });

  it("removeColumn：仅剩 1 列时不允许删除", () => {
    const one = parseTable(["| A |", "|---|", "| 1 |"].join("\n"))!;
    const out = removeColumn(one, 0);
    expect(out.align).toHaveLength(1);
  });

  it("addRow：在表头后（row=1）插入空数据行", () => {
    const out = addRow(t, 1);
    expect(out.cells).toHaveLength(4);
    expect(out.cells[1]).toEqual(["", "", ""]);
    // 原第一行未被改
    expect(out.cells[2][0]).toBe("就地编辑");
  });

  it("removeRow：删除第 1 数据行", () => {
    const out = removeRow(t, 1);
    expect(out.cells).toHaveLength(2);
    expect(out.cells[1][0]).toBe("行列增删");
  });

  it("removeRow：数据行少于等于 1 不允许删除", () => {
    const two = parseTable(["| A |", "|---|", "| 1 |"].join("\n"))!;
    const out = removeRow(two, 1);
    expect(out.cells).toHaveLength(2);
  });

  it("setAlignment：设置某列为居中，往返保留", () => {
    const out = setAlignment(t, 0, "c");
    expect(out.align[0]).toBe("c");
    expect(parseTable(reflowTable(out))!.align[0]).toBe("c");
  });

  it("结构性操作组合：增列→删行→对齐→往返为合法表格", () => {
    let m = addColumn(t, 2);
    m = removeRow(m, 1);
    m = setAlignment(m, 1, "r");
    const out = reflowTable(m);
    const r = parseTable(out);
    expect(r).not.toBeNull();
    expect(r!.cells[0]).toEqual(["功能", "状态", "", "负责人"]);
    expect(r!.align[1]).toBe("r");
  });
});