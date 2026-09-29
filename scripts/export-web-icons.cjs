// Renders the icons of the embedded LibreChat's pages (browser tab, home screen) from the brand SVGs:
//   npx electron scripts/export-web-icons.cjs brand build/web
// File names match LibreChat's client/dist/assets; scripts/build-server.mjs copies them over its own.
const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const [pattern, out] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!pattern || !out) throw new Error("usage: electron scripts/export-web-icons.cjs <brandDir> <outDir>");
const scratch = mkdtempSync(join(tmpdir(), "lamplight-web-"));

const ICONS = [
  ["favicon-16x16.png", "favicon.svg", 16],
  ["favicon-32x32.png", "favicon.svg", 32],
  ["apple-touch-icon-180x180.png", "web-square.svg", 180],
  ["icon-192x192.png", "web-square.svg", 192],
  ["maskable-icon.png", "web-maskable.svg", 512],
];

let win;
let seq = 0;
async function render(file, size) {
  win ??= new BrowserWindow({ show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.setContentSize(size, size);
  const src = `data:image/svg+xml;base64,${readFileSync(join(pattern, file)).toString("base64")}`;
  const page = join(scratch, `p${seq++}.html`);
  writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent"><img src="${src}" style="display:block;width:${size}px;height:${size}px">`);
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 200));
  return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  for (const [name, file, size] of ICONS) writeFileSync(join(out, name), await render(file, size));
  rmSync(scratch, { recursive: true, force: true });
  console.log(`web icons written to ${out}`);
  app.exit(0);
});
