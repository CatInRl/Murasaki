import { createApp } from "vue";
import { createPinia } from "pinia";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import App from "./App.vue";
import { i18n } from "./i18n";
import { executeTool as agentExecuteTool } from "./agent/tools";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(i18n);
app.mount("#app");

// E2E 测试辅助：暴露 Pinia 到 window
// 桌面应用 WebView 内部 window 仅应用代码可访问，无 XSS 风险
// 测试通过 browser.execute 调用 store action（绕过原生对话框）
// @ts-ignore
window.__pinia__ = pinia;
// E2E 测试辅助：暴露 agent executeTool
// 测试中不能用 import("/src/agent/tools.ts")（生产构建无 Vite dev server）
// @ts-ignore
window.__agentTools__ = { executeTool: agentExecuteTool };
