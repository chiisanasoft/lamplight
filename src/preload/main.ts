import { contextBridge, ipcRenderer } from "electron";

declare const location: { protocol: string } | undefined;
declare const window: { top: unknown };

// Runs in every frame of the main and settings windows (nodeIntegrationInSubFrames). Only Lamplight's
// own pages get an API; LibreChat and anything it frames (artifacts, previews) get none.
const pageProtocol = location?.protocol;

if (pageProtocol === "file:") {
  // Startup and offline pages
  contextBridge.exposeInMainWorld("lamplight", {
    retry: () => ipcRenderer.send("app:retry"),
    openSettings: () => ipcRenderer.send("app:openSettings"),
    startupState: () => ipcRenderer.invoke("startup:state"),
    onStartupStep: (cb: (step: unknown) => void) => ipcRenderer.on("startup:step", (_e, step) => cb(step)),
    consent: () => ipcRenderer.send("startup:consent"),
    retryStartup: () => ipcRenderer.send("startup:retry"),
  });
} else if (pageProtocol === "lamplight:") {
  // Settings page (its own window, or a tab of LibreChat's settings dialog)
  contextBridge.exposeInMainWorld("lamplight", {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch: unknown) => ipcRenderer.invoke("settings:save", patch),
    testServer: (url: string) => ipcRenderer.invoke("settings:testServer", url),
    ollamaModels: () => ipcRenderer.invoke("settings:ollamaModels"),
    relaunch: () => ipcRenderer.send("app:relaunch"),
    openServerFile: (which: string) => ipcRenderer.invoke("settings:openServerFile", which),
    extList: () => ipcRenderer.invoke("ext:list"),
    extInstallFile: () => ipcRenderer.invoke("ext:installFile"),
    extInstallCatalog: (id: string) => ipcRenderer.invoke("ext:installCatalog", id),
    extSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("ext:setEnabled", id, enabled),
    extSaveSettings: (id: string, settings: Record<string, string>) => ipcRenderer.invoke("ext:saveSettings", id, settings),
    extUninstall: (id: string) => ipcRenderer.invoke("ext:uninstall", id),
    extRestartServer: () => ipcRenderer.send("ext:restartServer"),
    onFocusSection: (cb: (id: string) => void) => ipcRenderer.on("settings:focusSection", (_e, id: string) => cb(id)),
  });
} else if (window.top === window) {
  // LibreChat's page: only tells the patched LibreChat build that it runs inside the desktop app
  contextBridge.exposeInMainWorld("lamplightDesktop", { desktop: true });
}
