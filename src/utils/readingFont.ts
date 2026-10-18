/**
 * 应用阅读字体预设（#433）：把 --murasaki-font-reading 写到根元素。
 *
 * 预览 / 所见即所得 / 导出共用同一个 CSS 变量；启动恢复与设置变更都走这里，
 * 避免两处各写一遍 `READING_FONT_PRESETS[...] ?? READING_FONT_PRESETS.d`。
 */
import { READING_FONT_PRESETS, type ReadingFontPreset } from "../types";

export function applyReadingFontPreset(preset: ReadingFontPreset): void {
  document.documentElement.style.setProperty(
    "--murasaki-font-reading",
    READING_FONT_PRESETS[preset] ?? READING_FONT_PRESETS.d
  );
}
