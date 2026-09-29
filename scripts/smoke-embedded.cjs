// First-run smoke test of the embedded server with a throwaway profile:
//   npm run build && npx electron scripts/smoke-embedded.cjs <outDir> [profileDir]
// Agrees to the MongoDB download, waits until LibreChat is signed in, captures the window and quits.
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const [outDir = "smoke-embedded", profileArg] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const profile = profileArg ?? mkdtempSync(join(tmpdir(), "lamplight-embedded-"));
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
// Keep an existing profile's settings (e.g. the saved port) so repeated runs test a real relaunch
const configPath = join(profile, "config.json");
let existing = {};
try {
  existing = JSON.parse(require("node:fs").readFileSync(configPath, "utf8"));
} catch {}
writeFileSync(configPath, JSON.stringify({
  favorites: [{ label: "Qwen 3.5 9B", endpoint: "Ollama", model: "qwen3.5:9b" }],
  ...existing,
  ...(process.env.SMOKE_FORMAT_LLM ? { ocrFormatModel: process.env.SMOKE_FORMAT_LLM } : {}),
  serverMode: "embedded",
}));
mkdirSync(outDir, { recursive: true });
console.log("profile", profile);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const shot = async (win, name) => writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG());

require("../dist/main/main.js");

app.whenReady().then(async () => {
  const mainWin = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "Lamplight クイック入力");
  await new Promise((r) => setTimeout(r, 2500));
  const w = mainWin();
  log("window", w?.webContents.getURL().split("/").pop());
  if (w?.webContents.getURL().includes("startup.html")) {
    await shot(w, "1-consent.png");
    log("consent -> download");
    ipcMain.emit("startup:consent");
  }
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const url = mainWin()?.webContents.getURL() ?? "";
    if (url.startsWith("http://127.0.0.1") && !url.includes("/login")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const win = mainWin();
  await new Promise((r) => setTimeout(r, 5000));
  // Optional: list the endpoints the signed-in user sees
  if (process.env.SMOKE_ENDPOINTS) {
    const eps = await win.webContents.executeJavaScript(`fetch("/api/auth/refresh", { method: "POST" })
      .then((r) => r.json())
      .then((t) => fetch("/api/endpoints", { headers: { Authorization: "Bearer " + t.token } }))
      .then((r) => r.json())`);
    for (const [name, e] of Object.entries(eps)) log(`endpoint ${name}: userProvide=${e.userProvide}`);
  }
  if (process.env.SMOKE_MODELS) {
    const models = await win.webContents.executeJavaScript(`fetch("/api/auth/refresh", { method: "POST" })
      .then((r) => r.json())
      .then((t) => fetch("/api/models", { headers: { Authorization: "Bearer " + t.token } }))
      .then((r) => r.json())`);
    log("ollama models:", JSON.stringify(models.ollama ?? models.Ollama));
  }
  // Optional end-to-end chat through the quick entry path: SMOKE_PROMPT="..."
  if (process.env.SMOKE_PROMPT) {
    log("quick entry prompt");
    ipcMain.emit("quick:submit", {}, { prompt: process.env.SMOKE_PROMPT, favoriteIndex: 0 });
    await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_WAIT_MS ?? 30000)));
    const text = await win.webContents.executeJavaScript("document.querySelector('main')?.innerText ?? document.body.innerText");
    log("page text:", text.replace(/\s+/g, " ").slice(0, 400));
  }
  log("final url", win.webContents.getURL(), "title", win.getTitle());
  await shot(win, "2-signed-in.png");
  log("quitting");
  app.quit();
});
app.on("will-quit", () => log("stopped"));
