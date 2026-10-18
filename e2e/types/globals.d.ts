/**
 * E2E 专用 Window 运行时钩子声明（#443）。
 *
 * 这些属性由应用（`src/main.ts` / `App.vue`）或测试脚本在运行时挂到 `window` 上，
 * 业务源码的 TS 工程并不声明它们。e2e 通过 WebDriver 注入脚本访问，统一在这里
 * 声明为可选的 `any`，避免每个调用点分散地写 `as any`。
 */
declare global {
  interface Window {
    /** `main.ts` 暴露的 Pinia 实例 */
    __pinia__?: any;
    /** `App.vue` 暴露的编辑器桥（getView / undo / redo） */
    __editorRef__?: any;
    /** Tauri 运行时内部对象（invoke / metadata） */
    __TAURI_INTERNALS__?: any;
    /** `App.vue` 初始化完成（恢复设置 / 工作区 / 标签之后）时置 true */
    __appReady__?: boolean;
    /** `App.vue` 暴露的侧栏视图切换 */
    __setSidebarView__?: any;
    /** 设置面板暴露的内部逻辑（部分用例直接读写） */
    __settingsLogic__?: any;
    /** `callStoreAction` 注入的 store action 调用器 */
    __callAction?: any;
    /** `callStoreAction` 暂存异步 action 结果的槽位 */
    __testResult?: any;
    /** Rust 侧注入的 webview console 环形缓冲 */
    __murasakiConsoleBuffer__?: any;
    /** HTML 导出钩子 */
    __exportHtml__?: any;
    // 右键菜单 / 对话框 / toast 用例在页面上下文里使用的临时状态
    __menuAction?: any;
    __actionCalled?: any;
    __disabledActionCalled?: any;
    __testActionCalled?: any;
    __alertResult?: any;
    __confirmResult?: any;
    __confirmResult2?: any;
    __promptResult?: any;
    __promptResult2?: any;
    __conflictResult?: any;
    __unsavedResult?: any;
    __d1?: any;
    __d2?: any;
  }
}

export {};
