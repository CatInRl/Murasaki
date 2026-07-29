import { createApp } from "vue";
import { createPinia } from "pinia";
import "../styles/theme.css";
import "./settings.css";
import SettingsApp from "./SettingsApp.vue";

const app = createApp(SettingsApp);
app.use(createPinia());
app.mount("#app");