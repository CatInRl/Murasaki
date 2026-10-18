/**
 * E2E 运行时钩子的类型声明（#443）。
 *
 * 应用在启动末尾把这些对象挂到 `window` 上供 E2E 通过 WebDriver 访问。
 * 集中声明后业务代码不需要再写 `@ts-ignore`，e2e 侧也有统一的类型来源。
 */
import type { Pinia } from "pinia";
import type { EditorView } from "@codemirror/view";
import type { SidebarView } from "./types";

/** `App.vue` 暴露的编辑器桥 */
export interface E2EEditorBridge {
  getView(): EditorView | null;
  scrollToLine(line: number): void;
  focus(): void;
  undo(): void;
  redo(): void;
}

declare global {
  interface Window {
    /** `main.ts` 暴露的 Pinia 实例 */
    __pinia__?: Pinia;
    /** `App.vue` 暴露的编辑器桥 */
    __editorRef__?: E2EEditorBridge;
    /** HTML 导出纯函数 */
    __exportHtml__?: (...args: any[]) => any;
    /** 切换 markdown 主题 */
    __setTheme__?: (theme: string) => void;
    /** 切换侧栏视图 */
    __setSidebarView__?: (view: SidebarView) => void;
    /** 设置面板的纯函数（settingsLogic） */
    __settingsLogic__?: Record<string, unknown>;
    /** 应用恢复完毕后置 true（E2E 就绪判据） */
    __appReady__?: boolean;
  }
}

export {};
