/**
 * T2.1 (0.8.0) — 行首中文符号转 Markdown 记号纯函数测试。
 *
 * 覆盖 convertLineStartSymbol：
 * - 单字符映射（》→ >、·→ -、＊→ *、＃→ #、～→ ~、－→ -）
 * - 多字符规则优先（···→ ```、【】→ []、＊＊＊→ ***）
 * - 嵌套/连续符号（》》→ >>、＃＃→ ##、》》》→ >>>）
 * - 前导空格保留
 * - 行首外的符号不转换 / 混入不可转换字符整串不转换
 * - 光标位于行首 / 空串不转换
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import {
  convertLineStartSymbol,
  FULLWIDTH_TO_MARKDOWN_MAPPINGS,
  fullwidthToMarkdownExtension,
} from "./fullwidthToMarkdown";

describe("convertLineStartSymbol - 单字符映射", () => {
  it("》 转为 >", () => {
    expect(convertLineStartSymbol("》", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "> ",
    });
  });

  it("· 转为 -", () => {
    expect(convertLineStartSymbol("·", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "- ",
    });
  });

  it("＊ 转为 *", () => {
    expect(convertLineStartSymbol("＊", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "* ",
    });
  });

  it("＃ 转为 #", () => {
    expect(convertLineStartSymbol("＃", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "# ",
    });
  });

  it("～ 转为 ~", () => {
    expect(convertLineStartSymbol("～", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "~ ",
    });
  });

  it("－ 转为 -", () => {
    expect(convertLineStartSymbol("－", 1)).toEqual({
      from: 0,
      to: 1,
      insert: "- ",
    });
  });
});

describe("convertLineStartSymbol - 多字符规则优先", () => {
  it("··· 转为 ```（优先于单 ·）", () => {
    expect(convertLineStartSymbol("···", 3)).toEqual({
      from: 0,
      to: 3,
      insert: "``` ",
    });
  });

  it("【】 转为 []", () => {
    expect(convertLineStartSymbol("【】", 2)).toEqual({
      from: 0,
      to: 2,
      insert: "[] ",
    });
  });

  it("＊＊＊ 转为 ***（优先于单 ＊）", () => {
    expect(convertLineStartSymbol("＊＊＊", 3)).toEqual({
      from: 0,
      to: 3,
      insert: "*** ",
    });
  });
});

describe("convertLineStartSymbol - 嵌套/连续符号", () => {
  it("》》 转为 >>", () => {
    expect(convertLineStartSymbol("》》", 2)).toEqual({
      from: 0,
      to: 2,
      insert: ">> ",
    });
  });

  it("》》》 转为 >>>（嵌套引用）", () => {
    expect(convertLineStartSymbol("》》》", 3)).toEqual({
      from: 0,
      to: 3,
      insert: ">>> ",
    });
  });

  it("＃＃ 转为 ##", () => {
    expect(convertLineStartSymbol("＃＃", 2)).toEqual({
      from: 0,
      to: 2,
      insert: "## ",
    });
  });

  it("【】》 混合序列可全部转换", () => {
    expect(convertLineStartSymbol("【】》", 3)).toEqual({
      from: 0,
      to: 3,
      insert: "[]> ",
    });
  });
});

describe("convertLineStartSymbol - 前导空格", () => {
  it("保留前导空格，from 从符号串起点开始", () => {
    expect(convertLineStartSymbol("  》", 3)).toEqual({
      from: 2,
      to: 3,
      insert: "> ",
    });
  });

  it("前导 Tab 同样保留", () => {
    expect(convertLineStartSymbol("\t·", 2)).toEqual({
      from: 1,
      to: 2,
      insert: "- ",
    });
  });
});

describe("convertLineStartSymbol - 不转换的情形", () => {
  it("光标在行首返回 null", () => {
    expect(convertLineStartSymbol("》", 0)).toBeNull();
  });

  it("空行/空前缀返回 null", () => {
    expect(convertLineStartSymbol("", 0)).toBeNull();
    expect(convertLineStartSymbol("  ", 2)).toBeNull();
  });

  it("符号不在行首（前面有普通字符）不转换", () => {
    expect(convertLineStartSymbol("abc》", 4)).toBeNull();
  });

  it("混入不可转换字符整串不转换", () => {
    expect(convertLineStartSymbol("》x", 2)).toBeNull();
    expect(convertLineStartSymbol("》x》", 3)).toBeNull();
  });

  it("符号串后跟空格再继续输入不转换（不连续）", () => {
    expect(convertLineStartSymbol("》 》", 3)).toBeNull();
  });
});

describe("FULLWIDTH_TO_MARKDOWN_MAPPINGS - 映射表一致性", () => {
  it("映射表条目 input 均非空且互不重复", () => {
    const inputs = FULLWIDTH_TO_MARKDOWN_MAPPINGS.map((m) => m.input);
    expect(inputs.length).toBeGreaterThan(0);
    expect(new Set(inputs).size).toBe(inputs.length);
  });

  it("每个映射的 output 都非空", () => {
    for (const m of FULLWIDTH_TO_MARKDOWN_MAPPINGS) {
      expect(m.output.length).toBeGreaterThan(0);
    }
  });
});

// ===== 事务级集成测试（走完整 transactionFilter 运行时路径）=====

interface StateOpts {
  enabled?: boolean;
  isMarkdown?: boolean;
}

function makeState(doc: string, opts: StateOpts = {}): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      opts.isMarkdown === false ? [] : markdown(),
      fullwidthToMarkdownExtension({
        isEnabled: () => opts.enabled !== false,
        isMarkdown: () => opts.isMarkdown !== false,
      }),
    ],
  });
}

/** 在 pos 处模拟"键入单个空格"事务（input.type），返回新状态 */
function typeSpace(state: EditorState, pos: number): EditorState {
  return state
    .update({
      changes: { from: pos, to: pos, insert: " " },
      userEvent: "input.type",
      selection: { anchor: pos + 1 },
    })
    .state;
}

describe("fullwidthToMarkdownExtension - 运行时转换", () => {
  it("行首 》，键入空格 → 转为 > ", () => {
    const s = typeSpace(makeState("》"), 1);
    expect(s.doc.toString()).toBe("> ");
  });

  it("行首 》》，键入空格 → 转为 >> ", () => {
    const s = typeSpace(makeState("》》"), 2);
    expect(s.doc.toString()).toBe(">> ");
  });

  it("行首 ”，键入空格 → 转为 - ", () => {
    const s = typeSpace(makeState("·"), 1);
    expect(s.doc.toString()).toBe("- ");
  });

  it("前导空格保留：  》 →   > ", () => {
    const s = typeSpace(makeState("  》"), 3);
    expect(s.doc.toString()).toBe("  > ");
  });

  it("非行首（》 前有普通字符）不转换", () => {
    const s = typeSpace(makeState("abc》"), 4);
    expect(s.doc.toString()).toBe("abc》 ");
  });

  it("混入不可转换字符整串不转换", () => {
    const s = typeSpace(makeState("》x"), 2);
    expect(s.doc.toString()).toBe("》x ");
  });
});

describe("fullwidthToMarkdownExtension - 门控（gating）", () => {
  it("功能关闭时不转换", () => {
    const s = typeSpace(makeState("》", { enabled: false }), 1);
    expect(s.doc.toString()).toBe("》 ");
  });

  it("非 markdown 文件不转换", () => {
    const s = typeSpace(makeState("》", { isMarkdown: false }), 1);
    expect(s.doc.toString()).toBe("》 ");
  });

  it("围栏代码块内不转换", () => {
    const s = typeSpace(makeState("```js\n》\n```"), 7);
    expect(s.doc.toString()).toBe("```js\n》 \n```");
  });

  it("围栏代码块内带前导空格的符号也不转换（会命中的 run 被代码范围拦截）", () => {
    const s = typeSpace(makeState("```\n  》\n```"), 7);
    expect(s.doc.toString()).toBe("```\n  》 \n```");
  });

  it("多光标同时键入空格不转换", () => {
    const s = makeState("》\n》");
    const next = s.update({
      changes: [
        { from: 1, to: 1, insert: " " },
        { from: 3, to: 3, insert: " " },
      ],
      userEvent: "input.type",
      selection: { anchor: 2, head: 5 },
    }).state;
    expect(next.doc.toString()).toBe("》 \n》 ");
  });
});

