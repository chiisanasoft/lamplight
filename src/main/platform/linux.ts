import { app, nativeImage } from "electron";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assetPath } from "../assets";
import type { Platform } from "./index";

const isWayland = () => process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;

export const linux: Platform = {
  prepare() {
    if (isWayland()) {
      // Wayland only allows global shortcuts through the XDG GlobalShortcuts portal
      app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
    }
  },

  trayIcon() {
    return nativeImage.createFromPath(assetPath("tray-linux.png"));
  },

  quickEntryWindowOptions() {
    return { backgroundColor: "#1d1a17" };
  },

  setLaunchAtLogin(enabled) {
    // XDG autostart entry; the AppImage path is exposed as $APPIMAGE
    const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart");
    const file = join(dir, "lamplight.desktop");
    if (!enabled) {
      rmSync(file, { force: true });
      return;
    }
    const exec = process.env.APPIMAGE || process.execPath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Lamplight",
      `Exec="${exec}" --hidden`,
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"));
  },

  shortcutFailureHint: isWayland()
    ? "Wayland ではデスクトップ環境の許可が必要です。表示されたダイアログで許可するか、システム設定のキーボードショートカットに登録してください。"
    : "他のアプリが同じショートカットを使っていないか確認してください。",
};
