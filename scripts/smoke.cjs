// Smoke run: electron scripts/smoke.cjs <outDir> <serverUrl>
// Starts Lamplight with a throwaway profile, captures every window and exits.
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const [outDir = "smoke", serverUrl = "http://localhost:3080"] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const profile = mkdtempSync(join(tmpdir(), "lamplight-smoke-"));
app.setPath("userData", profile);
writeFileSync(join(profile, "config.json"), JSON.stringify({
  serverUrl,
  favorites: [{ label: "Qwen 3.5 9B", endpoint: "Ollama", model: "qwen3.5:9b" }],
  defaultFavorite: 0,
}));
mkdirSync(outDir, { recursive: true });

require("../dist/main/main.js");

app.whenReady().then(() => setTimeout(() => ipcMain.emit("app:openSettings"), 2000));

app.whenReady().then(() => setTimeout(async () => {
  for (const [i, win] of BrowserWindow.getAllWindows().entries()) {
    if (!win.isVisible()) win.show();
    await new Promise((r) => setTimeout(r, 800));
    const img = await win.webContents.capturePage();
    const name = `${i}-${win.webContents.getURL().split("/").pop().split("?")[0] || "window"}.png`;
    writeFileSync(join(outDir, name), img.toPNG());
    console.log("captured", name, win.getTitle(), win.webContents.getURL().slice(0, 80));
  }
  app.exit(0);
}, 6000));
