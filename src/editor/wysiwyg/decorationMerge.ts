/**
 * WYSIWYG 窗口重算的装饰合并（#430）。
 *
 * 只重算光标周围的窗口时，新算出的装饰可能越过窗口边界
 * （跨行代码块 widget 整块替换、块尾换行上的实时预览卡等），
 * 因此剔除旧装饰的依据不是「是否在窗口内」，而是
 * 「是否与窗口或任一新装饰重叠」—— 其余旧装饰原样保留。
 */
import type { Range } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";

/** 文档范围 [from, to]。 */
export interface MergeRange {
  from: number;
  to: number;
}

function overlaps(aFrom: number, aTo: number, b: MergeRange): boolean {
  return aTo >= b.from && aFrom <= b.to;
}

/**
 * 把 `fresh` 的装饰合并进 `previous`：
 * - 与窗口或新装饰重叠的旧装饰被剔除（它们由本次重算负责）
 * - 新增全部 `fresh` 装饰（含越过窗口边界的整块 widget）
 * - 其余旧装饰原样保留
 */
export function mergeWindowDecorations(
  previous: DecorationSet,
  fresh: DecorationSet,
  recomputeWindow: MergeRange
): DecorationSet {
  const added: Range<Decoration>[] = [];
  let filterFrom = recomputeWindow.from;
  let filterTo = recomputeWindow.to;
  for (const cursor = fresh.iter(); cursor.value; cursor.next()) {
    added.push(cursor.value.range(cursor.from, cursor.to));
    filterFrom = Math.min(filterFrom, cursor.from);
    filterTo = Math.max(filterTo, cursor.to);
  }

  // 剔除范围 = 窗口 ∪ 全部新装饰的范围
  const drop: MergeRange[] = [recomputeWindow, ...added];
  return previous.update({
    filterFrom,
    filterTo,
    filter: (from, to) => !drop.some((range) => overlaps(from, to, range)),
    add: added,
  });
}
