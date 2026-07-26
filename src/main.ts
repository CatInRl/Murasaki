import { createApp } from "vue";
import { createPinia } from "pinia";
import "katex/dist/katex.min.css";
import App from "./App.vue";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.mount("#app");

// E2E 测试辅助：暴露 Pinia 到 window
// 桌面应用 WebView 内部 window 仅应用代码可访问，无 XSS 风险
// 测试通过 browser.execute 调用 store action（绕过原生对话框）
// @ts-ignore
window.__pinia__ = pinia;
