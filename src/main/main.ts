import { app, dialog, globalShortcut, ipcMain, Menu, session, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { ConfigStore, normalizeServerUrl, type Config } from "./config";
import { ExtensionManager, InstallCanceled } from "./extensions/manager";
import type { ExtensionManifest } from "./extensions/manifest";
import { currentPlatform as extensionPlatform } from "./extensions/manifest";
import { EmbeddedServer, ollamaModels, type StartupStep } from "./server/embedded";
import { preferredChatModel } from "./server/serverConfig";
import { watchResponses } from "./notifications";
import { currentPlatform } from "./platform";
import { probe, ServerStatus } from "./serverStatus";
import { AppTray } from "./tray";
import { isAppFrame, registerAppScheme, serveAppPages } from "./windows/appProtocol";
import { MainWindow, PARTITION } from "./windows/mainWindow";
import { QuickEntryWindow } from "./windows/quickEntry";
import { SettingsWindow } from "./windows/settingsWindow";
import { Updater } from "./updater";

// Separate profile for testing or portable use; must be set before anything reads userData
if (process.env.LAMPLIGHT_USER_DATA_DIR) app.setPath("userData", process.env.LAMPLIGHT_USER_DATA_DIR);

const platform = currentPlatform();
platform.prepare();
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const store = new ConfigStore(join(app.getPath("userData"), "config.json"));
  const pkg = require("../../package.json") as { lamplight: { mongodbVersion: string } };
  const serverRoot = app.isPackaged
    ? join(process.resourcesPath, "server")
    : join(__dirname, "..", "..", "resources", "server");

  // The mode is fixed for the lifetime of the process; switching it relaunches the app
  const mode = store.get().serverMode;
  let embedded: EmbeddedServer | null = null;
  let embeddedStopped = false;
  let lastStep: StartupStep | null = null;
  let consentGiven: (() => void) | null = null;

  const serverUrl = () =>
    mode === "embedded" ? (embedded?.url ?? "http://127.0.0.1:0") : store.get().serverUrl;
  const serverReady = () => mode === "external" || !!embedded?.url;

  const extensions = new ExtensionManager(app.getPath("userData"));
  const main = new MainWindow(store, {
    serverUrl,
    isDownloadUrl: (url) => {
      const d = embedded?.proxyDownloads;
      return !!d && d.paths.some((p) => url.startsWith(`${d.origin}${p}`));
    },
    onLoginPage: mode === "embedded"
      ? async () => {
          try {
            await embedded?.signIn(PARTITION);
            return true;
          } catch {
            return false;
          }
        }
      : undefined,
  });
  const quick = new QuickEntryWindow(platform);
  const settings = new SettingsWindow();
  const updater = new Updater();
  let tray: AppTray;
  let status: ServerStatus;

  const newChat = (favorite?: Config["favorites"][number], prompt?: string) => {
    if (!serverReady()) return main.show();
    main.openNewChat({ favorite, prompt });
  };

  function sendStep(step: StartupStep) {
    lastStep = step;
    main.window?.webContents.send("startup:step", step);
    if (step.step === "ready" || step.step === "error") renderTray();
  }

  async function startEmbedded() {
    embeddedStopped = false;
    main.showStartup();
    embedded = new EmbeddedServer({
      serverRoot,
      mongodbVersion: pkg.lamplight.mongodbVersion,
      preferredPort: store.get().embeddedPort,
      onPortChosen: (port) => {
        if (port !== store.get().embeddedPort) store.update({ embeddedPort: port });
      },
      proxyExtension: activeProxyExtension(),
      onStep: sendStep,
      requestConsent: () => new Promise<void>((resolve) => (consentGiven = resolve)),
      confirmSecretsReset: async () => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          message: "Lamplight の暗号鍵を読み込めません",
          detail:
            "キーチェーンの「Lamplight Safe Storage」が削除されたか、アクセスが拒否された可能性があります。\n\n" +
            "アクセスを拒否しただけの場合は「終了」を選び、もう一度起動してアクセスを許可してください。\n\n" +
            "「鍵を作り直す」を選ぶと、新しい鍵でローカルアカウントを復旧します。会話は残りますが、保存した API キーは入力し直す必要があります。",
          buttons: ["鍵を作り直す", "終了"],
          defaultId: 1,
          cancelId: 1,
        });
        if (response !== 0) app.quit();
        return response === 0;
      },
      onCrash: (message) => {
        embedded!.url = null;
        main.showStartup();
        sendStep({ step: "error", message });
      },
    });
    try {
      const url = await embedded.start(PARTITION);
      if (embedded.firstRun) {
        // LibreChat would otherwise open on the agents picker; start with a chat-ready model
        const c = store.get();
        const favorite = c.favorites[c.defaultFavorite] ?? c.favorites[0];
        const model = favorite ? null : preferredChatModel(await ollamaModels());
        main.openNewChat({ favorite: favorite ?? (model ? { label: model, endpoint: "Ollama", model } : undefined) });
      } else {
        main.load(url);
      }
      void status.check();
    } catch {
      /* the startup page shows the error */
    }
  }

  /** The enabled "ollama-proxy" extension, if one is installed (only one can sit in front of Ollama). */
  function activeProxyExtension() {
    const c = store.get();
    const ext = extensions.installed().find((e) => e.manifest.type === "ollama-proxy" && c.extensions[e.manifest.id]?.enabled);
    if (!ext) return undefined;
    const id = ext.manifest.id;
    return {
      extension: ext,
      settings: extensionSettings(id),
      preferredPort: c.extensions[id]?.port,
      onPortChosen: (port: number) => {
        const cur = store.get().extensions;
        if (cur[id]?.port !== port) store.update({ extensions: { ...cur, [id]: { ...cur[id], port } } });
      },
    };
  }

  /** Saved settings of an extension, filled with the manifest's defaults. */
  function extensionSettings(id: string): Record<string, string> {
    const ext = extensions.get(id);
    const saved = store.get().extensions[id]?.settings ?? {};
    return Object.fromEntries((ext?.manifest.settings ?? []).map((s) => [s.key, saved[s.key] ?? s.default]));
  }

  function updateExtension(id: string, patch: Partial<Config["extensions"][string]>) {
    const cur = store.get().extensions;
    const base = cur[id] ?? { enabled: false, settings: {} };
    store.update({ extensions: { ...cur, [id]: { ...base, ...patch } } });
  }

  async function restartEmbedded() {
    await stopEmbedded();
    void startEmbedded();
  }

  async function stopEmbedded() {
    if (!embedded || embeddedStopped) return;
    embeddedStopped = true;
    await embedded.stop();
  }

  function registerShortcut(accelerator: string): string | null {
    globalShortcut.unregisterAll();
    try {
      if (globalShortcut.register(accelerator, () => quick.toggle())) return null;
      return `ショートカット「${accelerator}」を登録できませんでした。${platform.shortcutFailureHint}`;
    } catch {
      return `「${accelerator}」はショートカットとして使えない形式です（例: Alt+Space, CommandOrControl+Shift+L）。`;
    }
  }

  function renderTray() {
    tray?.render(store.get(), status?.state ?? "unknown", mode === "embedded" ? "内蔵サーバー" : store.get().serverUrl);
  }

  function buildAppMenu() {
    const isMac = process.platform === "darwin";
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac
        ? [{
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { label: "設定…", accelerator: "Cmd+,", click: () => void openSettings("desktop") },
              { label: "拡張機能…", click: () => void openSettings("extensions") },
              { label: "アップデートを確認…", click: () => void updater.checkInteractively() },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          }]
        : [{
            label: "ファイル",
            submenu: [
              { label: "設定…", accelerator: "Ctrl+,", click: () => void openSettings("desktop") },
              { label: "拡張機能…", click: () => void openSettings("extensions") },
              { label: "アップデートを確認…", click: () => void updater.checkInteractively() },
              { role: "quit" as const },
            ],
          }]),
      {
        label: "チャット",
        submenu: [
          { label: "新しいチャット", accelerator: "CmdOrCtrl+N", click: () => newChat() },
          { label: "クイック入力", click: () => quick.show() },
          { type: "separator" },
          { label: "サーバーを再読み込み", accelerator: "CmdOrCtrl+Shift+R", click: () => main.reloadServer() },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]));
  }

  /**
   * Opens the settings as tabs of LibreChat's settings dialog in the main window (patched build of
   * the embedded server), or in their own window when LibreChat is not showing or not patched.
   */
  async function openSettings(view: "desktop" | "extensions") {
    const wc = main.window?.webContents;
    const tab = view === "extensions" ? "lamplight-extensions" : "lamplight-desktop";
    if (mode === "embedded" && embedded?.url && wc && !wc.isDestroyed() && wc.getURL().startsWith(embedded.url)) {
      const opened = await wc
        .executeJavaScript(
          `window.__lamplightSettings === true && (window.dispatchEvent(new CustomEvent("lamplight:open-settings", { detail: ${JSON.stringify(tab)} })), true)`,
        )
        .catch(() => false);
      if (opened === true) {
        main.show();
        return;
      }
    }
    settings.show(view === "extensions" ? "extSection" : undefined);
  }

  function registerIpc() {
    // Only Lamplight's own pages may call the app; LibreChat and its frames share the main window
    const allowed = (e: IpcMainEvent | IpcMainInvokeEvent) => isAppFrame(e.senderFrame?.url);
    const handle = <A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown) =>
      ipcMain.handle(channel, (e, ...args) => {
        if (!allowed(e)) throw new Error(`${channel} is not available to this page`);
        return fn(e, ...(args as A));
      });
    const on = <A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void) =>
      ipcMain.on(channel, (e, ...args) => {
        if (allowed(e)) fn(e, ...(args as A));
      });

    handle("quick:state", () => {
      const c = store.get();
      return { favorites: c.favorites, defaultFavorite: c.defaultFavorite, shortcut: c.quickEntryShortcut };
    });
    on("quick:submit", (_e, payload: { prompt: string; favoriteIndex: number }) => {
      quick.hide();
      const c = store.get();
      const favorite = c.favorites[payload.favoriteIndex];
      if (payload.favoriteIndex >= 0 && favorite) store.update({ defaultFavorite: payload.favoriteIndex });
      newChat(favorite, String(payload.prompt ?? ""));
    });
    on("quick:hide", () => quick.hide());

    handle("settings:get", () => ({ ...store.get(), activeServerMode: mode }));
    handle("settings:save", (_e, patch: Partial<Config>) => {
      const before = store.get();
      if (typeof patch.serverUrl === "string") {
        try {
          patch.serverUrl = normalizeServerUrl(patch.serverUrl);
        } catch {
          return { ok: false, error: "サーバーの URL が正しくありません。" };
        }
      }
      const config = store.update(patch);
      let shortcutError: string | null = null;
      if (config.quickEntryShortcut !== before.quickEntryShortcut) {
        shortcutError = registerShortcut(config.quickEntryShortcut);
      }
      if (config.launchAtLogin !== before.launchAtLogin) platform.setLaunchAtLogin(config.launchAtLogin);
      if (mode === "external" && config.serverUrl !== before.serverUrl) {
        main.reloadServer();
        void status.check();
      }
      renderTray();
      return { ok: true, config, shortcutError, restartRequired: config.serverMode !== mode };
    });
    handle("settings:testServer", async (_e, url: string) => {
      try {
        return await probe(normalizeServerUrl(url));
      } catch {
        return false;
      }
    });
    // Models installed in the local Ollama, offered as favorites for LibreChat's "Ollama" endpoint
    handle("settings:ollamaModels", () => ollamaModels());

    // Opens the embedded server's settings files (created on first start) in the default editor
    handle("settings:openServerFile", (_e, which: string) => {
      const dir = app.getPath("userData");
      const target = { serverEnv: "server.env", librechatYaml: "librechat.yaml", dataDir: "" }[which];
      return target === undefined ? "unknown file" : shell.openPath(join(dir, target));
    });

    on("app:openSettings", () => settings.show());
    on("app:retry", () => main.reloadServer());
    on("app:relaunch", () => {
      app.relaunch();
      app.quit();
    });

    handle("startup:state", () => lastStep);
    on("startup:consent", () => {
      consentGiven?.();
      consentGiven = null;
    });
    on("startup:retry", () => void restartEmbedded());

    // ---- extensions
    const extensionList = () => {
      const c = store.get();
      const installed = extensions.installed();
      return {
        platform: extensionPlatform(),
        mode,
        catalog: extensions.catalog().map((e) => ({ ...e, available: !!e.downloads[extensionPlatform()] })),
        installed: installed.map(({ manifest }) => ({
          manifest,
          enabled: !!c.extensions[manifest.id]?.enabled,
          settings: extensionSettings(manifest.id),
          running: !!embedded?.url && embedded.runningProxyId === manifest.id,
          official: c.extensions[manifest.id]?.official === true,
        })),
      };
    };
    const fail = (err: unknown) =>
      err instanceof InstallCanceled
        ? { ok: false, canceled: true }
        : { ok: false, error: err instanceof Error ? err.message : String(err) };
    // Anyone can build an extension; ones not signed by the Lamplight developers need a yes first
    const confirmUnofficial = async (m: ExtensionManifest) => {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: `「${m.name}」を追加しますか？`,
        detail:
          `この拡張機能は Lamplight の開発元が確認したものではありません${m.author ? `（作成者: ${m.author}）` : ""}。\n\n` +
          "拡張機能はこのコンピューターの上で、あなたの権限でプログラムを実行します。入手元を信頼できる場合だけ追加してください。",
        buttons: ["追加する", "キャンセル"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    };
    // A newly added extension is enabled and replaces any other of the same type (one proxy in front of Ollama)
    const activateInstalled = ({ manifest, official }: { manifest: ExtensionManifest; official: boolean }) => {
      for (const other of extensions.installed()) {
        if (other.manifest.id !== manifest.id && other.manifest.type === manifest.type) updateExtension(other.manifest.id, { enabled: false });
      }
      updateExtension(manifest.id, { enabled: true, official });
      return { ok: true, name: manifest.name, restartRequired: mode === "embedded" };
    };
    handle("ext:list", () => extensionList());
    handle("ext:installFile", async () => {
      const pick = await dialog.showOpenDialog({
        title: "拡張機能を追加",
        properties: ["openFile"],
        filters: [{ name: "Lamplight 拡張機能", extensions: ["lamplightext"] }],
      });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
      try {
        return activateInstalled(await extensions.installFromFile(pick.filePaths[0], confirmUnofficial));
      } catch (err) {
        return fail(err);
      }
    });
    handle("ext:installCatalog", async (_e, id: string) => {
      try {
        return activateInstalled(await extensions.installFromCatalog(id, () => {}, confirmUnofficial));
      } catch (err) {
        return fail(err);
      }
    });
    handle("ext:setEnabled", (_e, id: string, enabled: boolean) => {
      if (enabled) {
        const type = extensions.get(id)?.manifest.type;
        for (const other of extensions.installed()) {
          if (other.manifest.id !== id && other.manifest.type === type) updateExtension(other.manifest.id, { enabled: false });
        }
      }
      updateExtension(id, { enabled });
      return { ok: true, restartRequired: mode === "embedded" };
    });
    handle("ext:saveSettings", async (_e, id: string, settings: Record<string, string>) => {
      updateExtension(id, { settings });
      // A running extension picks the settings up by restarting just its own process
      if (embedded?.url && embedded.runningProxyId === id) await embedded.restartProxy(extensionSettings(id));
      return { ok: true };
    });
    handle("ext:uninstall", (_e, id: string) => {
      const wasRunning = extensionList().installed.some((e) => e.manifest.id === id && e.running);
      extensions.uninstall(id);
      updateExtension(id, { enabled: false });
      return { ok: true, restartRequired: wasRunning };
    });
    on("ext:restartServer", () => void restartEmbedded());
  }

  app.on("second-instance", () => main.show());
  app.on("activate", () => main.show());
  app.on("before-quit", (e) => {
    main.quitting = true;
    // Shut the embedded server and database down cleanly before exiting
    if (embedded && !embeddedStopped) {
      e.preventDefault();
      void stopEmbedded().finally(() => app.quit());
    }
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  // Stay alive in the tray when every window is closed
  app.on("window-all-closed", () => {
    if (!store.get().keepRunningInTray) app.quit();
  });

  app.setName("Lamplight");
  app.setAboutPanelOptions({
    applicationName: "Lamplight",
    applicationVersion: app.getVersion(),
    credits: "LibreChat をベースにしたデスクトップアプリです。LibreChat 公式のアプリではありません。",
  });

  void app.whenReady().then(() => {
    serveAppPages(session.defaultSession);
    serveAppPages(session.fromPartition(PARTITION));
    buildAppMenu();
    registerIpc();

    status = new ServerStatus(serverUrl, () => renderTray());
    tray = new AppTray(platform, {
      newChat: (f) => newChat(f),
      quickEntry: () => quick.show(),
      showWindow: () => main.show(),
      settings: () => void openSettings("desktop"),
      extensions: () => void openSettings("extensions"),
      quit: () => app.quit(),
    });
    renderTray();
    status.start();

    watchResponses({
      partition: PARTITION,
      serverUrl,
      enabled: () => store.get().notifyOnComplete,
      isWindowFocused: () => !!main.window?.isFocused(),
      windowTitle: () => main.window?.getTitle() ?? "",
      onClick: () => main.show(),
    });

    const shortcutError = registerShortcut(store.get().quickEntryShortcut);
    if (shortcutError) {
      void dialog.showMessageBox({ type: "warning", message: "クイック入力のショートカット", detail: shortcutError });
    }

    if (store.get().checkForUpdates) updater.checkInBackground();
    if (mode === "embedded") void startEmbedded();
    else main.create(!process.argv.includes("--hidden"));
    quick.warmUp();
  });
}
