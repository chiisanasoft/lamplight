// Builds, signs and packs an extension of this repository: node scripts/build-extension.mjs extensions/ocr
// (Extensions made elsewhere are packed with scripts/pack-extension.mjs; see docs/EXTENSIONS.md.)
//
// Output: release/extensions/<id>-<version>-<platform>-<arch>.lamplightext (a .tar.gz) containing the
// extension's files, CHECKSUMS (sha256 of every file) and SIGNATURE (Ed25519 over CHECKSUMS).
// Packages are per platform because extensions may ship native modules.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { packExtension } from "./pack-extension.mjs";

const root = resolve(import.meta.dirname, "..");
const extDir = resolve(process.argv[2] ?? "extensions/ocr");
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;
if (!manifest.platforms.includes(platform)) throw new Error(`${manifest.id} does not list ${platform} in manifest.platforms`);
const keyPath = process.env.LAMPLIGHT_EXT_SIGNING_KEY ?? join(homedir(), ".config", "lamplight", "extension-signing-key.pem");
const outDir = join(root, "release", "extensions");
const stage = join(outDir, `${manifest.id}-stage`);
const pkgName = `${manifest.id}-${manifest.version}-${platform}.lamplightext`;

const run = (cmd, args, cwd) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

// 1. build
run("npx", ["tsc", "-p", join(root, `tsconfig.ext.json`)], root);

// 2. stage the runtime files and production dependencies
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["manifest.json", "package.json", "package-lock.json"]) cpSync(join(extDir, f), join(stage, f));
cpSync(join(extDir, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], stage);

// 3. drop what the extension never loads (Node uses pdf.js's legacy build)
const drop = [
  "node_modules/.bin",
  "node_modules/.package-lock.json",
  "node_modules/pdfjs-dist/build",
  "node_modules/pdfjs-dist/web",
  "node_modules/pdfjs-dist/types",
  "node_modules/pdfjs-dist/image_decoders",
];
for (const d of drop) rmSync(join(stage, d), { recursive: true, force: true });

// 4. CHECKSUMS + SIGNATURE (the Lamplight key makes the package official), then pack
if (!existsSync(keyPath)) throw new Error(`signing key not found: ${keyPath} (run scripts/extension-key.mjs)`);
const out = join(outDir, pkgName);
const count = packExtension(stage, out, { signingKey: keyPath });
rmSync(stage, { recursive: true, force: true });
const size = (lstatSync(out).size / 1048576).toFixed(1);
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
console.log(`\n${relative(root, out)}  ${size} MB  (${count} files)\nsha256 ${sha}`);
