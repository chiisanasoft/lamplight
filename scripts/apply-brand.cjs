// Builds the app's icon assets from one brand pattern:
//   npx electron scripts/apply-brand.cjs brand
// Writes build/icon.png, build/icon.icns, build/trayTemplate(@2x).png, build/tray-linux.png
// and build/logo.svg (shown in place of LibreChat's logo inside the main window).
const { app, BrowserWindow } = require("electron");
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const pattern = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!pattern) throw new Error("usage: electron scripts/apply-brand.cjs <brandDir>");
const scratch = mkdtempSync(join(tmpdir(), "lamplight-apply-"));
const svg = (name) => `data:image/svg+xml;base64,${readFileSync(join(pattern, name)).toString("base64")}`;

let win;
let seq = 0;
async function render(name, size) {
  win ??= new BrowserWindow({ show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.setContentSize(size, size);
  const page = join(scratch, `p${seq++}.html`);
  writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent">
    <img src="${svg(name)}" style="display:block;width:${size}px;height:${size}px;object-fit:contain">`);
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 200));
  return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), await render("icon.svg", base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), await render("icon.svg", base * 2));
  }
  if (process.platform === "darwin") {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", "build/icon.icns"]);
  }
  writeFileSync("build/icon.png", await render("icon.svg", 512));
  writeFileSync("build/trayTemplate.png", await render("tray.svg", 18));
  writeFileSync("build/trayTemplate@2x.png", await render("tray.svg", 36));
  writeFileSync("build/tray-linux.png", await render("icon.svg", 32));
  copyFileSync(join(pattern, "icon.svg"), "build/logo.svg");
  rmSync(scratch, { recursive: true, force: true });
  console.log(`applied ${pattern}`);
  app.exit(0);
});
