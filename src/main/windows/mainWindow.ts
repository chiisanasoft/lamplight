import { app, BrowserWindow, Notification, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { assetPath } from "../assets";
import { APP_NAME, brandCss, brandTitle } from "../brand";
import type { ConfigStore } from "../config";
import { buildNewChatUrl, isServerUrl, type NewChatOptions } from "../urls";

/** Session partition shared by all windows so the LibreChat login persists across restarts */
export const PARTITION = "persist:lamplight";

function loadBrandCss(): string {
  try {
    const svg = readFileSync(assetPath("logo.svg"));
    return brandCss(`data:image/svg+xml;base64,${svg.toString("base64")}`);
  } catch {
    return "";
  }
}

export interface MainWindowHooks {
  /** Current LibreChat server URL (embedded or external) */
  serverUrl(): string;
  /** Called when LibreChat shows its login page; the embedded server signs in again */
  onLoginPage?(): Promise<boolean>;
  /** Links to files the app saves itself instead of opening a browser (OCR Excel exports) */
  isDownloadUrl?(url: string): boolean;
}

export class MainWindow {
  private win: BrowserWindow | null = null;
  /** Set when the app is really quitting, so "close" does not just hide */
  quitting = false;

  constructor(private readonly store: ConfigStore, private readonly hooks: MainWindowHooks) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** @param loadServer false while the embedded server is still starting (the startup page is shown instead) */
  create(show = true, loadServer = true): BrowserWindow {
    if (this.window) return this.window;
    const { mainWindowBounds: b } = this.store.get();
    const win = new BrowserWindow({
      width: b?.width ?? 1200,
      height: b?.height ?? 820,
      x: b?.x,
      y: b?.y,
      minWidth: 480,
      minHeight: 400,
      show: false,
      title: APP_NAME,
      backgroundColor: "#1d1a17",
      webPreferences: {
        partition: PARTITION,
        preload: join(__dirname, "..", "..", "preload", "main.js"),
        // The preload also runs in frames: the settings tabs inside LibreChat are lamplight:// frames
        nodeIntegrationInSubFrames: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.win = win;

    win.once("ready-to-show", () => show && win.show());
    win.on("close", (e) => {
      this.saveBounds();
      if (!this.quitting && this.store.get().keepRunningInTray) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on("closed", () => (this.win = null));

    this.guardNavigation(win);
    this.handleDownloads(win);
    this.applyBranding(win);
    win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED (a newer navigation replaced this one)
      if (isMainFrame && code !== -3) this.showOffline(url, description);
    });

    this.watchLoginPage(win);
    if (loadServer) this.load(this.hooks.serverUrl());
    return win;
  }

  /** Links to other sites open in the default browser; the window only ever shows LibreChat. */
  private guardNavigation(win: BrowserWindow) {
    const server = () => this.hooks.serverUrl();
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (this.hooks.isDownloadUrl?.(url)) {
        win.webContents.downloadURL(url);
        return { action: "deny" };
      }
      if (isServerUrl(server(), url)) return { action: "allow" };
      if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (isServerUrl(server(), url) || url.startsWith("file:")) return;
      e.preventDefault();
      if (this.hooks.isDownloadUrl?.(url)) return win.webContents.downloadURL(url);
      if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url);
    });
  }

  /** Saves downloads (e.g. OCR Excel files) to the Downloads folder and tells the user where. */
  private downloadsHandled = false;

  private handleDownloads(win: BrowserWindow) {
    // The session outlives the window; register once
    if (this.downloadsHandled) return;
    this.downloadsHandled = true;
    win.webContents.session.on("will-download", (_e, item) => {
      const dir = app.getPath("downloads");
      const name = item.getFilename();
      let target = join(dir, name);
      for (let n = 2; existsSync(target); n++) target = join(dir, `${basename(name, extname(name))} (${n})${extname(name)}`);
      item.setSavePath(target);
      item.once("done", (_ev, state) => {
        if (!Notification.isSupported()) return;
        const n = new Notification(
          state === "completed"
            ? { title: "ダウンロードしました", body: basename(target) }
            : { title: "ダウンロードできませんでした", body: name },
        );
        if (state === "completed") n.on("click", () => shell.showItemInFolder(target));
        n.show();
      });
    });
  }

  private applyBranding(win: BrowserWindow) {
    const css = loadBrandCss();
    win.webContents.on("page-title-updated", (e, title) => {
      e.preventDefault();
      win.setTitle(brandTitle(title));
    });
    win.webContents.on("dom-ready", () => {
      if (css && isServerUrl(this.hooks.serverUrl(), win.webContents.getURL())) {
        void win.webContents.insertCSS(css);
      }
    });
  }

  /** Re-signs in once when the session expired and LibreChat falls back to /login. */
  private watchLoginPage(win: BrowserWindow) {
    let retrying = false;
    win.webContents.on("did-navigate-in-page", (_e, url) => void check(url));
    win.webContents.on("did-navigate", (_e, url) => void check(url));
    const check = async (url: string) => {
      if (retrying || !this.hooks.onLoginPage || !isServerUrl(this.hooks.serverUrl(), url)) return;
      if (new URL(url).pathname !== "/login") return;
      retrying = true;
      try {
        if (await this.hooks.onLoginPage()) this.load(this.hooks.serverUrl());
      } finally {
        setTimeout(() => (retrying = false), 10_000);
      }
    };
  }

  /** Local page that shows the embedded server's startup progress. */
  showStartup() {
    const win = this.create(true, false);
    void win.loadFile(join(__dirname, "..", "..", "renderer", "startup.html"));
    return win;
  }

  load(url: string) {
    void this.window?.loadURL(url).catch(() => {
      /* handled by did-fail-load */
    });
  }

  private showOffline(url: string, reason: string) {
    const page = join(__dirname, "..", "..", "renderer", "offline.html");
    void this.window?.loadFile(page, { query: { url: this.hooks.serverUrl(), failed: url, reason } });
  }

  reloadServer() {
    this.load(this.hooks.serverUrl());
  }

  /**
   * Opens a new chat (optionally with a model) and sends the prompt. The prompt is typed into
   * LibreChat's input instead of using its ?prompt=&submit= URL parameters: LibreChat rewrites the
   * new-chat URL to endpoint/model only while the model is applied, which can drop those parameters.
   */
  async openNewChat(opts: NewChatOptions = {}) {
    const win = this.create();
    this.show(win);
    try {
      await win.loadURL(buildNewChatUrl(this.hooks.serverUrl(), { favorite: opts.favorite }));
    } catch {
      return; // did-fail-load shows the offline page
    }
    const prompt = opts.prompt?.trim();
    if (prompt) await this.typePrompt(win, prompt);
  }

  private async typePrompt(win: BrowserWindow, prompt: string) {
    const focusInput = `(() => {
      const t = document.querySelector('textarea[data-testid="text-input"]') || document.querySelector('form textarea');
      if (!t || t.disabled) return false;
      t.focus();
      // Select any draft LibreChat restored, so the prompt replaces it instead of being appended
      t.select();
      return document.activeElement === t;
    })()`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) return;
      if (await win.webContents.executeJavaScript(focusInput).catch(() => false)) {
        // Give LibreChat a moment to apply the selected model before sending
        await new Promise((r) => setTimeout(r, 600));
        await win.webContents.executeJavaScript(focusInput).catch(() => false);
        win.webContents.insertText(prompt);
        await new Promise((r) => setTimeout(r, 150));
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  show(win = this.create()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  toggle() {
    const win = this.window;
    if (win?.isVisible() && win.isFocused()) win.hide();
    else this.show();
  }

  private saveBounds() {
    const win = this.window;
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    this.store.update({ mainWindowBounds: win.getNormalBounds() });
  }
}
