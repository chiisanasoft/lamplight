import { app, nativeImage } from "electron";
import { assetPath } from "../assets";
import type { Platform } from "./index";

export const darwin: Platform = {
  prepare() {},

  trayIcon() {
    // "Template" images adapt to light/dark menu bars automatically
    const img = nativeImage.createFromPath(assetPath("trayTemplate.png"));
    img.setTemplateImage(true);
    return img;
  },

  quickEntryWindowOptions() {
    return { vibrancy: "hud", visualEffectState: "active", transparent: true };
  },

  setLaunchAtLogin(enabled) {
    app.setLoginItemSettings({ openAtLogin: enabled });
  },

  shortcutFailureHint: "他のアプリ（Spotlight・Raycast など）が同じショートカットを使っていないか確認してください。",
};
