import { describe, it, expect, vi, afterEach } from "vitest";
import { TableEditor } from "./tableEditor";
import { parseTable } from "./tableReflow";

const source = [
  "| 功能 | 状态 | 负责人 |",
  "|:---|:---:|---:|",
  "| 就地编辑 | 进行中 | UI 组 |",
  "| 行列增删 | 待办 | 引擎组 |",
].join("\n");

/**
 * jsdom 的全局 Selection.addRange 对 contentEditable 表格不稳定（rangeCount 时 0 时 1），
 * 因此由测试注入一个固定的 selection stub：rangeCount 恒为 1，getRangeAt(0) 返回真实的
 * document Range。这样 keydown 的 caretAtEdge / Enter 分支读到确定的状态，而 Range 的
 * insertNode / deleteContents / startContainer 仍走 jsdom 真实实现，保证断言真实有效。
 */
let getSelectionSpy: ReturnType<typeof vi.spyOn> | undefined;
const rangeHolder: { range: Range | null } = { range: null };
const selectionStub = {
  rangeCount: 1,
  getRangeAt: (i: number) => rangeHolder.range as unknown as Range,
  removeAllRanges: () => {},
  addRange: () => {},
  collapse: () => {},
};

/** 在 jsdom 中搭起编辑宿主，返回句柄。 */
function setup(src = source) {
  const wrapper = document.createElement("div");
  document.body.appendChild(wrapper);
  const commit = vi.fn();
  const editor = new TableEditor(src, { onCommit: commit });
  const table = editor.render(wrapper);
  const cellAt = (row: number, col: number) =>
    table.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLTableCellElement;
  /** jsdom 的 focus() 是 no-op：手动派发 FocusEvent 以触发 bindCell 的锚点逻辑。 */
  const focus = (row: number, col: number) => cellAt(row, col).dispatchEvent(new FocusEvent("focus"));
  const lastCommit = (): string => {
    const calls = commit.mock.calls as [string][];
    return calls[calls.length - 1][0];
  };
  return { wrapper, table, editor, commit, cellAt, focus, lastCommit };
}

/** 把光标基于文本节点放到指定格，并注入对应 selection stub（Range 为真实对象）。 */
function placeCaret(cell: HTMLTableCellElement, offset: number) {
  const tn = cell.firstChild as Text;
  const range = document.createRange();
  range.setStart(tn, Math.min(Math.max(0, offset), tn.data.length));
  range.collapse(true);
  rangeHolder.range = range;
  if (!getSelectionSpy) {
    getSelectionSpy = vi.spyOn(document, "getSelection").mockReturnValue(selectionStub as unknown as Selection);
  }
}

afterEach(() => {
  rangeHolder.range = null;
  getSelectionSpy?.mockRestore();
  getSelectionSpy = undefined;
  document.body.textContent = "";
});

describe("TableEditor 渲染", () => {
  it("渲染出 contentEditable 的 table（th/td 均可编辑）", () => {
    const { table } = setup();
    expect(table.className).toContain("murasaki-wysiwyg-table-grid");
    expect(table.querySelectorAll("[data-row]")).toHaveLength(9); // 表头 3 + 数据 6
    table.querySelectorAll("th,td").forEach((c) => {
      expect((c as HTMLTableCellElement).contentEditable).toBe("true");
    });
  });

  it("对齐样式落到单元格（左/中/右）", () => {
    const { cellAt } = setup();
    expect(cellAt(0, 0).style.textAlign).toBe("left");
    expect(cellAt(0, 1).style.textAlign).toBe("center");
    expect(cellAt(0, 2).style.textAlign).toBe("right");
  });
});

describe("悬停插入胶囊", () => {
  it("宿主容器内创建右缘(＋列)/底缘(＋行)两个胶囊，mousedown 被阻止默认", () => {
    const { wrapper } = setup();
    const right = wrapper.querySelector(".murasaki-table-edge-cap-right") as HTMLButtonElement;
    const bottom = wrapper.querySelector(".murasaki-table-edge-cap-bottom") as HTMLButtonElement;
    expect(right).not.toBeNull();
    expect(bottom).not.toBeNull();
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    right.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
  });

  it("无锚点时点底缘胶囊 → 追加末尾空行并写回", () => {
    const { wrapper, table, lastCommit, commit } = setup();
    (wrapper.querySelector(".murasaki-table-edge-cap-bottom") as HTMLButtonElement).click();
    expect(table.tBodies[0].rows).toHaveLength(3);
    const out = parseTable(lastCommit())!;
    expect(out.cells).toHaveLength(4);
    expect(out.cells[3]).toEqual(["", "", ""]);
    expect(commit).toHaveBeenCalled();
  });

  it("无锚点时点右缘胶囊 → 追加末尾空列并写回", () => {
    const { wrapper, table, lastCommit } = setup();
    (wrapper.querySelector(".murasaki-table-edge-cap-right") as HTMLButtonElement).click();
    expect(table.rows[0].cells).toHaveLength(4);
    expect(parseTable(lastCommit())!.align).toHaveLength(4);
  });

  it("有锚点时点右缘胶囊 → 在锚点列之后插列", () => {
    const { wrapper, focus, lastCommit, cellAt } = setup();
    focus(1, 0); // 锚点 = 列 0
    (wrapper.querySelector(".murasaki-table-edge-cap-right") as HTMLButtonElement).click();
    const out = parseTable(lastCommit())!;
    expect(out.align).toHaveLength(4);
    // 新列插在锚点(列0)之后，即第 1 列，默认左对齐
    expect(out.align[1]).toBe("l");
    expect(out.cells[1][1]).toBe("");
    expect(parseTable(lastCommit())!.cells[1][2]).toBe("进行中"); // 原列1后移
  });

  it("有锚点时点底缘胶囊 → 在锚点行之后插行", () => {
    const { wrapper, focus, lastCommit } = setup();
    focus(1, 0); // 锚点 = 数据行 1
    (wrapper.querySelector(".murasaki-table-edge-cap-bottom") as HTMLButtonElement).click();
    const out = parseTable(lastCommit())!;
    expect(out.cells).toHaveLength(4);
    expect(out.cells[2]).toEqual(["", "", ""]);
    expect(out.cells[3][0]).toBe("行列增删"); // 原行2后移
  });
});

describe("方向键格间导航", () => {
  it("格内行首按 ← 跨到左一列", () => {
    const { cellAt } = setup();
    const target = cellAt(1, 0);
    const spy = vi.spyOn(target, "focus");
    placeCaret(cellAt(1, 1), 0); // 行首
    cellAt(1, 1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
  });

  it("格内行尾按 → 跨到右一列", () => {
    const { cellAt } = setup();
    const target = cellAt(1, 1);
    const spy = vi.spyOn(target, "focus");
    placeCaret(cellAt(1, 0), cellAt(1, 0).textContent!.length); // 行尾
    cellAt(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
  });

  it("格内行首按 ↑ 跨到上一行（表头）且列不变", () => {
    const { cellAt } = setup();
    const target = cellAt(0, 0);
    const spy = vi.spyOn(target, "focus");
    placeCaret(cellAt(1, 0), 0); // 行首（before 为空）
    cellAt(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
  });

  it("当前格在左边界(x0)按 ← 被 clamp 留在同一格（不越界不跳行）", () => {
    const { cellAt } = setup();
    const stay = vi.spyOn(cellAt(1, 0), "focus");
    const header = vi.spyOn(cellAt(0, 0), "focus");
    placeCaret(cellAt(1, 0), 0);
    cellAt(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(stay).toHaveBeenCalled(); // clamp 到列 0，仍在 (1,0)
    expect(header).not.toHaveBeenCalled(); // 未越界跳到表头
  });

  it("光标不在格边缘按方向键不跨格（边界判断）", () => {
    const { cellAt } = setup();
    const neighbor = cellAt(1, 1);
    const spy = vi.spyOn(neighbor, "focus");
    // “就地编辑” 光标放中间（offset 1）
    placeCaret(cellAt(1, 0), 1);
    cellAt(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Tab / 多行格", () => {
  it("Tab 横向导航到下一格，Shift+Tab 反向", () => {
    const { cellAt } = setup();
    let target = cellAt(0, 2);
    let spy = vi.spyOn(target, "focus");
    placeCaret(cellAt(0, 1), 2);
    cellAt(0, 1).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();

    target = cellAt(0, 1);
    spy = vi.spyOn(target, "focus");
    cellAt(0, 2).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
  });

  it("Enter 在格内插入 <br> 换行，不触发提交", () => {
    const { cellAt, commit } = setup();
    const cell = cellAt(1, 0);
    placeCaret(cell, cell.textContent!.length);
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(cell.querySelector("br")).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("多行格（<br>）写回为字面 <br>，且不拆表", () => {
    const { cellAt, lastCommit, editor } = setup();
    const cell = cellAt(1, 0);
    cell.textContent = "";
    cell.appendChild(document.createTextNode("第一行"));
    cell.appendChild(document.createElement("br"));
    cell.appendChild(document.createTextNode("第二行"));
    editor.commit();
    const src = lastCommit();
    expect(src).toContain("第一行<br>第二行");
    // 行数不变（表头 + 分隔 + 2 数据 = 4 行），多行内容不拆表
    expect(src.split("\n")).toHaveLength(4);
    expect(src.split("\n")[2]).toContain("第一行<br>第二行");
  });

  it("Esc 提交整表并写回，随后锚点清除", () => {
    const { cellAt, lastCommit } = setup();
    placeCaret(cellAt(1, 0), 0);
    cellAt(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(parseTable(lastCommit())).not.toBeNull();
    expect(cellAt(1, 0).classList.contains("murasaki-anchor-cell")).toBe(false);
  });
});

describe("工具条 / 结构化操作与边界保护", () => {
  it("canDeleteRow/canDeleteColumn 在边界处为 false", () => {
    const single = setup(["| A |", "|:--|", "| 1 |"].join("\n"));
    expect(single.editor.canDeleteColumn()).toBe(false); // 仅 1 列
    expect(single.editor.canDeleteRow()).toBe(false); // 表头 + 1 数据行
  });

  it("removeColumnAtAnchor 删除锚点列并写回", () => {
    const { editor, focus, lastCommit } = setup();
    focus(1, 2); // 锚点列 2（负责人）
    editor.removeColumnAtAnchor();
    const out = parseTable(lastCommit())!;
    expect(out.align).toHaveLength(2);
    expect(out.cells[1]).toEqual(["就地编辑", "进行中"]);
  });

  it("removeRowAtAnchor 删除锚点行并写回", () => {
    const { editor, focus, lastCommit } = setup();
    focus(1, 0);
    editor.removeRowAtAnchor();
    const out = parseTable(lastCommit())!;
    expect(out.cells).toHaveLength(2);
    expect(out.cells[1][0]).toBe("行列增删");
  });

  it("setAnchorAlignment 设置锚点列对齐并写回分隔行", () => {
    const { editor, focus, lastCommit } = setup();
    focus(1, 0); // 列 0 默认左
    editor.setAnchorAlignment("c");
    expect(parseTable(lastCommit())!.align[0]).toBe("c");
  });
});