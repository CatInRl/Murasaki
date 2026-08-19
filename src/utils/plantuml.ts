/**
 * PlantUML 纯浏览器渲染（官方 TeaVM 产物，无需服务器）。
 *
 * 供 PreviewPane（分屏/预览）与 WYSIWYG 实时预览卡共用，避免重复的加载逻辑。
 *
 * 依赖关系：
 * - viz-global.js（官方 Viz.js 3.x 全局产物，定义全局 `Viz`）→ Graphviz/Dot 布局
 * - plantuml.js（官方独立 ES module）→ 把 PlantUML 源码行渲染为 SVG
 */

interface PlantUmlApi {
  /** 把 PlantUML 源码行渲染为 SVG 并写入 targetId 元素的 innerHTML */
  render(lines: string[], targetId: string, opts?: { dark?: boolean }): void;
}

let plantUmlReady: Promise<PlantUmlApi> | null = null;

/**
 * 加载 viz-global.js（官方 Viz.js 3.x 全局产物），定义全局 `Viz`，
 * 供 plantuml.js 的 Graphviz/Dot 布局使用。普通 script 一次性注入 + 缓存。
 */
function ensureVizLoaded(): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = import.meta.env.BASE_URL ?? "/";
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-murasaki-plantuml-viz]"
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("加载 viz-global.js 失败")),
        { once: true }
      );
      if ((existing as HTMLScriptElement & { _loaded?: boolean })._loaded) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = `${base}plantuml/viz-global.js`;
    s.dataset.murasakiPlantumlViz = "1";
    s.onload = () => {
      (s as HTMLScriptElement & { _loaded?: boolean })._loaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("加载 viz-global.js 失败"));
    document.head.appendChild(s);
  });
}

/** 确保 plantuml.js 已加载（先加载依赖 viz-global.js），返回其模块接口 */
export async function ensurePlantUml(): Promise<PlantUmlApi> {
  if (!plantUmlReady) {
    plantUmlReady = (async () => {
      await ensureVizLoaded();
      const base = import.meta.env.BASE_URL ?? "/";
      // 官方产物是独立 ES module，不参与 Vite bundle，运行时动态 import
      const mod = await import(/* @vite-ignore */ `${base}plantuml/plantuml.js`);
      return mod as unknown as PlantUmlApi;
    })();
  }
  return plantUmlReady;
}

/**
 * 把一段 PlantUML 源码渲染进 target 元素的 innerHTML。
 * 失败时在 target 内写入错误信息，调用方可据此展示渲染结果状态。
 *
 * @param code PlantUML 源码
 * @param target 渲染目标的元素（id 会被覆盖以定位）
 * @param idPrefix 生成的元素 id 前缀（保证多实例并发时 id 唯一）
 */
export async function renderPlantUmlCode(
  code: string,
  target: HTMLElement,
  idPrefix = "plantuml"
): Promise<void> {
  try {
    const plantuml = await ensurePlantUml();
    const id = `${idPrefix}-${Math.random().toString(36).slice(2, 10)}`;
    target.id = id;
    plantuml.render([code], id, { dark: false });
  } catch (err) {
    target.innerHTML = `<pre style="color:#c00">${(err as Error).message}</pre>`;
  }
}