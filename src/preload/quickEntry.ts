import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lamplight", {
  state: () => ipcRenderer.invoke("quick:state"),
  submit: (prompt: string, favoriteIndex: number) => ipcRenderer.send("quick:submit", { prompt, favoriteIndex }),
  hide: () => ipcRenderer.send("quick:hide"),
  onOpened: (cb: () => void) => ipcRenderer.on("quick:opened", () => cb()),
});
