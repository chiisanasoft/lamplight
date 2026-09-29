import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { Platform } from "../platform";

const WIDTH = 680;
const HEIGHT = 150;

/** Frameless floating prompt, shown by the global shortcut (like ChatGPT's ⌥Space). */
export class QuickEntryWindow {
  private win: BrowserWindow | null = null;

  constructor(private readonly platform: Platform) {}

  private create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      ...this.platform.quickEntryWindowOptions(),
      webPreferences: {
        preload: join(__dirname, "..", "..", "preload", "quickEntry.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // Without skipTransformProcessType, macOS turns the whole app into a UIElement (no Dock icon, no menu bar)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.on("blur", () => win.hide());
    void win.loadFile(join(__dirname, "..", "..", "renderer", "quick-entry.html"));
    this.win = win;
    return win;
  }

  /** Preload the window so the first shortcut press opens instantly. */
  warmUp() {
    this.create();
  }

  show() {
    const win = this.create();
    // Upper third of the display under the cursor
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    win.setPosition(Math.round(x + (width - WIDTH) / 2), Math.round(y + height * 0.22));
    win.webContents.send("quick:opened");
    win.show();
    win.focus();
  }

  hide() {
    this.win?.hide();
  }

  toggle() {
    if (this.win?.isVisible()) this.hide();
    else this.show();
  }
}
