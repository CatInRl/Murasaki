/**
 * Mermaid 主题变量（issue #295）
 *
 * 背景：此前唯一的 `mermaid.initialize` 写在 PreviewPane.vue 内，WYSIWYG 直接对全局
 * mermaid 实例调 `render`。于是「先开 WYSIWYG」就会掉回 Mermaid 默认主题——一个隐式
 * 副作用（初始化与否取决于预览窗格是否先渲染过）。
 *
 * 现在初始化与取值都收在本模块：分栏预览与 WYSIWYG 都走 `ensureMermaid()`，任一处先
 * 渲染都会带上 token 派生的主题。Mermaid 仍按需懒加载（不在应用启动时引入）。
 */

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

/** themeVariables 缓存：主色运行期不变，首次读一次即可（issue #295） */
let themeVariablesCache: Record<string, string> | null = null;

function readToken(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

/**
 * 从 `document.documentElement` 的 `--murasaki-*` token 解析值构造 Mermaid
 * themeVariables。首次调用时读 `getComputedStyle` 并缓存；改主色后需
 * `refreshMermaidTheme()` 清缓存才会重取。
 */
export function buildMermaidThemeVariables(): Record<string, string> {
  if (themeVariablesCache) return themeVariablesCache;
  const styles = getComputedStyle(document.documentElement);
  // #fdf4ff 不在色阶/语义 token 内，就地保留（issue #294 判断类保留）。
  // secondaryColor 与 secondBkg 同值，提成具名常量避免同一字面值写两遍。
  const secondarySurface = "#fdf4ff";
  themeVariablesCache = {
    primaryColor: readToken(styles, "--murasaki-purple-100"),
    primaryBorderColor: readToken(styles, "--murasaki-primary"),
    primaryTextColor: readToken(styles, "--murasaki-purple-900"),
    lineColor: readToken(styles, "--murasaki-primary"),
    secondaryColor: secondarySurface,
    tertiaryColor: readToken(styles, "--murasaki-purple-50"),
    background: readToken(styles, "--murasaki-background"),
    mainBkg: readToken(styles, "--murasaki-purple-100"),
    secondBkg: secondarySurface,
    borderColor: readToken(styles, "--murasaki-primary"),
    edgeLabelBackground: readToken(styles, "--murasaki-purple-50"),
    clusterBkg: readToken(styles, "--murasaki-purple-50"),
    clusterBorder: readToken(styles, "--murasaki-primary"),
  };
  return themeVariablesCache;
}

/**
 * 清空 themeVariables 缓存，并允许下一次 `ensureMermaid()` 用新 token 值重新 initialize。
 *
 * 本轮无调用点 —— 用途：将来真上「主色可配置」时，改完 `--murasaki-primary` 调一下它，
 * 图表配色即可跟随新主色。
 */
export function refreshMermaidTheme(): void {
  themeVariablesCache = null;
  mermaidReady = null;
  initPromise = null;
}

let mermaidReady: MermaidApi | null = null;
let initPromise: Promise<MermaidApi> | null = null;

/**
 * 懒加载 mermaid（保留按需引入，不在应用启动时加载），并用 token 派生的 themeVariables
 * 初始化一次（幂等）。分栏预览与 WYSIWYG 共用，消除「WYSIWYG 依赖 PreviewPane 先
 * initialize」的隐式副作用。
 */
export async function ensureMermaid(): Promise<MermaidApi> {
  if (mermaidReady) return mermaidReady;
  if (!initPromise) {
    initPromise = import("mermaid").then((mod) => {
      const mermaid = (mod.default ?? mod) as unknown as MermaidApi;
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        securityLevel: "loose",
        themeVariables: buildMermaidThemeVariables(),
      });
      mermaidReady = mermaid;
      return mermaid;
    });
  }
  return initPromise;
}

// ===== SVG 渲染后处理（issue #342）=====

export interface MermaidRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 判定哪些 gantt 的 today 线（按传入顺序的索引）相对内容包围盒完全落在可见域
 * 之外（左侧或右侧）。任务时间域全在过去（或全在未来）时，mermaid 11 会把 today
 * 线画到内容域外很远处（实测 x=18151 而内容宽约 1264）并把该线计入根 viewBox——
 * viewBox 被撑出内容十几倍后，SVG 被容器等比压缩成几像素高的线，整图不可读。
 * 部分跨界（x 在域内）保守不隐藏。
 */
export function todayLineIndexesOutsideContentBox(
  contentBox: MermaidRect,
  todayBBoxes: MermaidRect[],
): number[] {
  const left = contentBox.x;
  const right = contentBox.x + contentBox.width;
  const out: number[] = [];
  todayBBoxes.forEach((b, i) => {
    if (b.x === 0 && b.y === 0 && b.width === 0 && b.height === 0) return;
    if (b.x + b.width < left || b.x > right) out.push(i);
  });
  return out;
}

export function unionRect(a: MermaidRect, b: MermaidRect): MermaidRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * mermaid 渲染结果注入 DOM 后的统一后处理，三个渲染入口（分栏预览、WYSIWYG
 * MermaidWidget、WYSIWYG 实时预览卡）共用。处理 gantt 的 today 线溢出：
 *
 * 1. 隐藏全部 today 线后取根 `getBBox()` 得到真实内容包围盒（display:none 的子树
 *    不计入 getBBox）；
 * 2. 完全落在内容域之外的 today 线保持隐藏，域内/跨界线恢复显示并并入包围盒；
 * 3. viewBox 收窄到最终包围盒，并把 inline `max-width` 同步为内容宽度（mermaid
 *    原值按被污染的 viewBox 计算，不重设会在宽容器里拉伸）。
 *
 * svg 未挂载（getBBox 抛错/全 0）、环境不支持 getBBox（jsdom）、无 svg、无
 * viewBox、无 g.today 时全部静默 no-op 且不改动原状。
 */
export function sanitizeMermaidSvg(container: ParentNode): void {
  const svg =
    container instanceof SVGElement ? container : container.querySelector("svg");
  if (!svg) return;
  if (!svg.getAttribute("viewBox")) return;
  const todayGroups = svg.querySelectorAll("g.today");
  if (todayGroups.length === 0) return;

  const bboxes: MermaidRect[] = [];
  for (const g of Array.from(todayGroups)) {
    try {
      const b = (g as SVGGElement).getBBox();
      bboxes.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    } catch {
      return;
    }
  }

  const prevDisplay = Array.from(todayGroups, (g) => (g as SVGElement).style.display);
  for (const g of Array.from(todayGroups)) {
    (g as SVGElement).style.display = "none";
  }

  let contentBox: MermaidRect | null = null;
  try {
    const b = (svg as SVGGraphicsElement).getBBox();
    if (b.width > 0 && b.height > 0) {
      contentBox = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  } catch {
    contentBox = null;
  }

  if (!contentBox) {
    for (let i = 0; i < todayGroups.length; i++) {
      (todayGroups[i] as SVGElement).style.display = prevDisplay[i];
    }
    return;
  }

  const out = todayLineIndexesOutsideContentBox(contentBox, bboxes);
  let finalBox = contentBox;
  for (let i = 0; i < todayGroups.length; i++) {
    if (out.includes(i)) continue;
    (todayGroups[i] as SVGElement).style.display = prevDisplay[i];
    finalBox = unionRect(finalBox, bboxes[i]);
  }

  svg.setAttribute(
    "viewBox",
    `${finalBox.x} ${finalBox.y} ${finalBox.width} ${finalBox.height}`,
  );
  (svg as SVGElement).style.maxWidth = `${finalBox.width}px`;
}
