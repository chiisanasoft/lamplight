import { BrowserWindow } from "electron";
import { join } from "node:path";
import { APP_ORIGIN } from "./appProtocol";

export class SettingsWindow {
  private win: BrowserWindow | null = null;

  /** @param section id of a settings section to scroll to (e.g. "extSection") */
  show(section?: string) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      if (section) this.win.webContents.send("settings:focusSection", section);
      return;
    }
    const win = new BrowserWindow({
      width: 620,
      height: 720,
      minWidth: 520,
      minHeight: 560,
      title: "Lamplight の設定",
      backgroundColor: "#1d1a17",
      show: false,
      webPreferences: {
        preload: join(__dirname, "..", "..", "preload", "main.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => (this.win = null));
    if (section) win.webContents.once("did-finish-load", () => win.webContents.send("settings:focusSection", section));
    void win.loadURL(`${APP_ORIGIN}/settings.html`);
    this.win = win;
  }
}
