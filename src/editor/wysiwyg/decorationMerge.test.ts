import { describe, it, expect } from "vitest";
import { Decoration, DecorationSet } from "@codemirror/view";
import { mergeWindowDecorations } from "./decorationMerge";

/**
 * #430：窗口重算后的装饰合并。
 *
 * 关键断言：新装饰即使越过窗口边界也要保留；与窗口/新装饰重叠的旧装饰被剔除，
 * 其余旧装饰原样保留。
 */
function setOf(items: Array<[number, number, string]>): DecorationSet {
  const ranges = items.map(([from, to, cls]) =>
    Decoration.mark({ class: cls }).range(from, to)
  );
  return Decoration.set(ranges, true);
}

function collect(set: DecorationSet): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { class?: string };
    out.push([cursor.from, cursor.to, spec.class ?? ""]);
  }
  return out;
}

describe("mergeWindowDecorations", () => {
  it("窗口内的旧装饰被新装饰替换，窗口外原样保留", () => {
    const previous = setOf([
      [0, 5, "old"],
      [100, 110, "keep"],
    ]);
    const fresh = setOf([[3, 8, "new"]]);

    const merged = mergeWindowDecorations(previous, fresh, { from: 3, to: 8 });

    expect(collect(merged)).toEqual([
      [3, 8, "new"],
      [100, 110, "keep"],
    ]);
  });

  it("新装饰越过窗口边界时整条保留，并剔除它覆盖的旧装饰", () => {
    const previous = setOf([
      [0, 4, "old"],
      [20, 30, "stale"], // 不与窗口重叠，但与新装饰重叠
      [100, 110, "keep"],
    ]);
    // 窗口 [3,8]，但新装饰是跨窗口的整块 widget [3,50]
    const fresh = setOf([[3, 50, "block"]]);

    const merged = mergeWindowDecorations(previous, fresh, { from: 3, to: 8 });

    expect(collect(merged)).toEqual([
      [3, 50, "block"],
      [100, 110, "keep"],
    ]);
  });

  it("窗口内没有新装饰时，旧装饰仍被剔除（切换为源码态）", () => {
    const previous = setOf([
      [0, 5, "stale"],
      [100, 110, "keep"],
    ]);

    const merged = mergeWindowDecorations(previous, Decoration.set([]), {
      from: 3,
      to: 8,
    });

    expect(collect(merged)).toEqual([[100, 110, "keep"]]);
  });
});
