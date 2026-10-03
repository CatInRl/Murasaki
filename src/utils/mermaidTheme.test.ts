import { describe, expect, it } from "vitest";
import {
  sanitizeMermaidSvg,
  todayLineIndexesOutsideContentBox,
  unionRect,
  type MermaidRect,
} from "./mermaidTheme";

const CONTENT_1264 = { x: 0, y: 0, width: 1264, height: 148 };

function rect(x: number, y: number, width: number, height: number): MermaidRect {
  return { x, y, width, height };
}

describe("todayLineIndexesOutsideContentBox", () => {
  it("today 线完全在内容域右侧之外 → 隐藏（gantt 任务域全在过去，today 画到 x=18151 的实测场景）", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [rect(18151, 25, 0, 98)]);
    expect(result).toEqual([0]);
  });

  it("today 线在内容域内 → 不隐藏", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [rect(1000, 25, 0, 98)]);
    expect(result).toEqual([]);
  });

  it("today 线完全在内容域左侧之外 → 隐藏", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [rect(-320, 25, 300, 98)]);
    expect(result).toEqual([0]);
  });

  it("today 线部分跨界（x 在域内、右缘超出）→ 保守不隐藏", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [rect(1200, 25, 100, 98)]);
    expect(result).toEqual([]);
  });

  it("退化矩形（getBBox 全 0）→ 跳过不误判为左侧在外", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [rect(0, 0, 0, 0)]);
    expect(result).toEqual([]);
  });

  it("多条 today 线混合 → 只返回在外的那几条", () => {
    const result = todayLineIndexesOutsideContentBox(CONTENT_1264, [
      rect(1000, 25, 0, 98),
      rect(18151, 25, 0, 98),
      rect(-50, 25, 30, 98),
    ]);
    expect(result).toEqual([1, 2]);
  });

  it("内容域带 x 偏移时同判定适用", () => {
    const box = { x: -50, y: -10, width: 450, height: 287 };
    expect(todayLineIndexesOutsideContentBox(box, [rect(400, 0, 0, 100)])).toEqual([]);
    expect(todayLineIndexesOutsideContentBox(box, [rect(9000, 0, 0, 100)])).toEqual([0]);
  });
});

describe("unionRect", () => {
  it("不相交：向右扩张到右者右缘", () => {
    expect(unionRect(CONTENT_1264, rect(1200, 25, 200, 98))).toEqual(rect(0, 0, 1400, 148));
  });

  it("包含关系：取外框不变", () => {
    expect(unionRect(CONTENT_1264, rect(100, 20, 50, 10))).toEqual(CONTENT_1264);
  });

  it("向左扩张（负坐标起点）", () => {
    expect(unionRect(CONTENT_1264, rect(-50, 25, 30, 98))).toEqual(rect(-50, 0, 1314, 148));
  });
});

const SVG_NS = "http://www.w3.org/2000/svg";

interface StubSvgOptions {
  viewBox: string | null;
  todayBBoxes: Array<MermaidRect | null>;
  rootBBox?: MermaidRect | null;
}

/**
 * 构造带 stub getBBox 的 mermaid svg（jsdom 无真实 getBBox 实现）。
 * rootBBox 传 null 表示不 stub 根元素——jsdom 下调用会抛，用于模拟环境不支持。
 */
function stubSvg({ viewBox, todayBBoxes, rootBBox }: StubSvgOptions): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  if (viewBox !== null) svg.setAttribute("viewBox", viewBox);
  if (rootBBox) {
    (svg as unknown as { getBBox: () => DOMRect }).getBBox = () =>
      ({ x: rootBBox.x, y: rootBBox.y, width: rootBBox.width, height: rootBBox.height }) as DOMRect;
  }
  for (const b of todayBBoxes) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "today");
    if (b !== null) {
      (g as unknown as { getBBox: () => DOMRect }).getBBox = () =>
        ({ x: b.x, y: b.y, width: b.width, height: b.height }) as DOMRect;
    }
    svg.appendChild(g);
  }
  return svg;
}

function todayAt(svg: SVGSVGElement, i: number): SVGElement {
  return svg.querySelectorAll("g.today")[i] as SVGElement;
}

describe("sanitizeMermaidSvg", () => {
  it("today 完全在内容域外 → 隐藏该线，viewBox 收窄到内容域，max-width 同步", () => {
    const svg = stubSvg({
      viewBox: "0 0 18152 148",
      todayBBoxes: [rect(18151, 25, 0, 98)],
      rootBBox: CONTENT_1264,
    });
    sanitizeMermaidSvg(svg);
    expect(todayAt(svg, 0).style.display).toBe("none");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
    expect(svg.style.maxWidth).toBe("1264px");
  });

  it("today 在内容域内 → 保留显示，viewBox 仍收窄到内容域", () => {
    const svg = stubSvg({
      viewBox: "0 0 18152 148",
      todayBBoxes: [rect(1000, 25, 0, 98)],
      rootBBox: CONTENT_1264,
    });
    sanitizeMermaidSvg(svg);
    expect(todayAt(svg, 0).style.display).toBe("");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
    expect(svg.style.maxWidth).toBe("1264px");
  });

  it("多条 today 线：只隐藏在外的那条", () => {
    const svg = stubSvg({
      viewBox: "0 0 18152 148",
      todayBBoxes: [rect(1000, 25, 0, 98), rect(6477, 25, 0, 98)],
      rootBBox: CONTENT_1264,
    });
    sanitizeMermaidSvg(svg);
    expect(todayAt(svg, 0).style.display).toBe("");
    expect(todayAt(svg, 1).style.display).toBe("none");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
  });

  it("跨界 today → 保留并把 viewBox 扩到其右缘（union 而非丢弃）", () => {
    const svg = stubSvg({
      viewBox: "0 0 18152 148",
      todayBBoxes: [rect(1200, 25, 200, 98)],
      rootBBox: CONTENT_1264,
    });
    sanitizeMermaidSvg(svg);
    expect(todayAt(svg, 0).style.display).toBe("");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1400 148");
    expect(svg.style.maxWidth).toBe("1400px");
  });

  it("根 getBBox 不可用（未挂载/环境不支持）→ 恢复原状 no-op", () => {
    const svg = stubSvg({
      viewBox: "0 0 1264 148",
      todayBBoxes: [rect(18151, 25, 0, 98)],
      rootBBox: null,
    });
    sanitizeMermaidSvg(svg);
    expect(todayAt(svg, 0).style.display).toBe("");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
    expect(svg.style.maxWidth).toBe("");
  });

  it("today 线 getBBox 不可用（jsdom 真实元素）→ no-op 不抛", () => {
    const svg = stubSvg({
      viewBox: "0 0 1264 148",
      todayBBoxes: [null],
      rootBBox: CONTENT_1264,
    });
    expect(() => sanitizeMermaidSvg(svg)).not.toThrow();
    expect(todayAt(svg, 0).style.display).toBe("");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
  });

  it("无 viewBox 属性 → no-op 不抛", () => {
    const svg = stubSvg({
      viewBox: null,
      todayBBoxes: [rect(18151, 25, 0, 98)],
      rootBBox: CONTENT_1264,
    });
    expect(() => sanitizeMermaidSvg(svg)).not.toThrow();
    expect(todayAt(svg, 0).style.display).toBe("");
  });

  it("容器内没有 svg → no-op 不抛", () => {
    const div = document.createElement("div");
    expect(() => sanitizeMermaidSvg(div)).not.toThrow();
  });

  it("无 g.today（流程图/时序图）→ no-op 不抛", () => {
    const svg = stubSvg({
      viewBox: "0 0 576 129",
      todayBBoxes: [],
      rootBBox: CONTENT_1264,
    });
    expect(() => sanitizeMermaidSvg(svg)).not.toThrow();
    expect(svg.getAttribute("viewBox")).toBe("0 0 576 129");
    expect(svg.style.maxWidth).toBe("");
  });

  it("从容器（渲染注入的父节点）里找到 svg 并处理", () => {
    const container = document.createElement("div");
    const svg = stubSvg({
      viewBox: "0 0 18152 148",
      todayBBoxes: [rect(18151, 25, 0, 98)],
      rootBBox: CONTENT_1264,
    });
    container.appendChild(svg);
    sanitizeMermaidSvg(container);
    expect(todayAt(svg, 0).style.display).toBe("none");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1264 148");
  });
});
