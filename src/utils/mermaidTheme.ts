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
