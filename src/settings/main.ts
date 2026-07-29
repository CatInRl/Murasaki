import { createApp, h, type FunctionalComponent } from "vue";
import "../styles/theme.css";

// 设置窗口 Vue 入口（占位）
// 具体设置表单内容由 T8.2 实现
const SettingsApp: FunctionalComponent = () =>
  h("div", { class: "settings-placeholder" }, "设置窗口");

createApp(SettingsApp).mount("#app");
