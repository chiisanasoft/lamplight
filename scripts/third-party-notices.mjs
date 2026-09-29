// Writes THIRD_PARTY_NOTICES.md: the third-party software shipped with Lamplight and its licenses.
//
//   npm run notices            (after npm install, npm run build:server and, for Linux, build:server:linux)
//
// Lists the runtime dependencies of the app, of the embedded LibreChat server (resources/server and
// any resources/server-<platform>-<arch>) and of the extensions in extensions/. The license texts
// themselves ship inside the app next to each package (node_modules/<name>/LICENSE…).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Licenses stated outside package.json (checked by hand; see the package's README). */
const KNOWN = {
  pause: "MIT",
  precond: "MIT",
};
/** Packages offered under a choice of licenses: the one Lamplight uses. */
const CHOSEN = { jszip: "MIT" };

function licenseOf(pkg) {
  if (KNOWN[pkg.name]) return KNOWN[pkg.name];
  const l = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => x.type ?? x).join(" OR ") : pkg.licenses?.type);
  if (!l) return "記載なし";
  return typeof l === "string" ? l : (l.type ?? JSON.stringify(l));
}

function repoOf(pkg) {
  const r = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!r) return pkg.homepage ?? "";
  return r
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^(ssh|git\+ssh):\/\/(git@)?github\.com\//, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1");
}

/** Every package installed under <dir>/node_modules (production installs only). */
function scanNodeModules(dir) {
  const found = new Map();
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const name of readdirSync(nm)) {
      if (name.startsWith(".")) continue;
      const path = join(nm, name);
      if (name.startsWith("@")) {
        walk(path);
        continue;
      }
      if (lstatSync(path).isSymbolicLink()) continue; // workspace links (the patched LibreChat itself)
      const pj = join(path, "package.json");
      if (existsSync(pj)) {
        const pkg = JSON.parse(readFileSync(pj, "utf8"));
        if (pkg.name && pkg.version) found.set(`${pkg.name}@${pkg.version}`, pkg);
      }
      walk(join(path, "node_modules"));
    }
  };
  walk(join(dir, "node_modules"));
  return found;
}

/** Runtime dependencies of an npm project (npm ls --omit=dev). */
function npmRuntimeDeps(dir) {
  const out = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: dir, encoding: "utf8" });
  const found = new Map();
  for (const path of out.split("\n").slice(1).filter(Boolean)) {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    found.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return found;
}

const serverDirs = readdirSync(join(root, "resources"))
  .filter((d) => d === "server" || d.startsWith("server-"))
  .map((d) => join(root, "resources", d));
if (!serverDirs.length) throw new Error("resources/server is missing; run `npm run build:server` first");
const server = new Map();
for (const d of serverDirs) for (const [k, v] of scanNodeModules(d)) server.set(k, v);
const librechat = JSON.parse(readFileSync(join(serverDirs[0], "LAMPLIGHT_BUILD.json"), "utf8")).librechat;

const extensionSections = readdirSync(join(root, "extensions"))
  .filter((id) => existsSync(join(root, "extensions", id, "package.json")))
  .map((id) => ({ id, deps: npmRuntimeDeps(join(root, "extensions", id)) }));

const electronVersion = JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version;

function table(deps) {
  const rows = [...deps.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((p) => {
      const license = CHOSEN[p.name] ? `${CHOSEN[p.name]}（${licenseOf(p)} から選択）` : licenseOf(p);
      return `| ${p.name} | ${p.version} | ${license} | ${repoOf(p)} |`;
    });
  return ["| パッケージ | バージョン | ライセンス | 入手先 |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function summary(deps) {
  const counts = new Map();
  for (const p of deps.values()) {
    const l = CHOSEN[p.name] ?? licenseOf(p);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}: ${n}`).join("、");
}

const doc = `# サードパーティ製ソフトウェア一覧

Lamplight が同梱するサードパーティ製ソフトウェアと、そのライセンスの一覧です。Lamplight 自体のライセンスは [LICENSE](LICENSE)（MIT）です。

本ファイルは \`npm run notices\` で生成しています。各パッケージのライセンス文は、アプリケーション内の各パッケージのフォルダ（\`node_modules/<名前>/LICENSE\` など）に同梱しています。

## 主な構成要素

| ソフトウェア | ライセンス | 同梱の有無 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) ${electronVersion}（Chromium・Node.js を含む） | MIT（Chromium などのライセンスはアプリケーション内の \`LICENSES.chromium.html\`） | 同梱 |
| [LibreChat](https://github.com/danny-avila/LibreChat) ${librechat} | MIT | パッチ（\`patches/librechat/\`）を適用して同梱。ライセンス文はアプリケーション内の \`server/LICENSE\` |
| [MongoDB Community Server](https://www.mongodb.com/) | SSPL | **同梱しない**。初回起動時に、利用者の同意を得て MongoDB 公式サイトから取得する |
| [Ollama](https://ollama.com) | MIT | **同梱しない**。利用者が別途インストールする |

## 注記

- \`@img/sharp-libvips-*\`（画像処理ライブラリ libvips のビルド済みバイナリ）は LGPL-3.0-or-later です。改変せずに共有ライブラリとして同梱しており、差し替えが可能です。ソースコードは https://github.com/libvips/libvips から入手できます。
- \`jszip\` は MIT と GPL-3.0 の選択制であり、Lamplight は MIT を選択しています。
- \`pause\`・\`precond\` は package.json にライセンスの記載がありませんが、README に MIT ライセンスである旨が記載されています。
- ライセンスが「記載なし」のパッケージは、配布物にライセンスの表記が確認できなかったものです。

## アプリケーション本体の依存パッケージ（${npmRuntimeDeps(root).size} 件）

${table(npmRuntimeDeps(root))}

## 内蔵サーバー（LibreChat ${librechat}）の依存パッケージ（${server.size} 件）

内訳: ${summary(server)}

${table(server)}

${extensionSections
  .map(({ id, deps }) => `## 拡張機能「${id}」の依存パッケージ（${deps.size} 件）

拡張機能は別途配布し、アプリケーションには同梱しません。

${table(deps)}`)
  .join("\n\n")}
`;

writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), doc);
console.log(`THIRD_PARTY_NOTICES.md: app ${npmRuntimeDeps(root).size}, server ${server.size}, ${extensionSections.map((e) => `${e.id} ${e.deps.size}`).join(", ")}`);
