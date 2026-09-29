// Publishes built extension packages (release/extensions/*.lamplightext) to GitHub Releases of
// chiisanasoft/lamplight, one release per extension version: ext-<id>-v<version>.
// Build them first with `npm run build:ext`. Uses the GitHub CLI (gh) and its sign-in.
//
// After publishing, point src/main/extensions/catalog.ts at the new file.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = "chiisanasoft/lamplight";
const dir = resolve(import.meta.dirname, "..", "release", "extensions");
const files = readdirSync(dir).filter((f) => f.endsWith(".lamplightext"));
if (!files.length) throw new Error(`no .lamplightext in ${dir}; run npm run build:ext first`);

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
for (const file of files) {
  const m = /^(.+)-(\d+\.\d+\.\d+[^-]*)-([a-z0-9]+-[a-z0-9]+)\.lamplightext$/.exec(file);
  if (!m) throw new Error(`unexpected file name: ${file}`);
  const [, id, version] = m;
  const tag = `ext-${id}-v${version}`;
  let exists = true;
  try {
    gh(["release", "view", tag, "-R", REPO]);
  } catch {
    exists = false;
  }
  if (exists) {
    gh(["release", "upload", tag, join(dir, file), "--clobber", "-R", REPO]);
  } else {
    gh(["release", "create", tag, join(dir, file), "-R", REPO, "--title", `${id} ${version}`, "--notes", `拡張機能 ${id} ${version}（Lamplight の署名付き）`]);
  }
  console.log(`${file} -> https://github.com/${REPO}/releases/download/${tag}/${file}`);
}
