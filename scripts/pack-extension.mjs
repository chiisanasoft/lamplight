#!/usr/bin/env node
// Packs a ready extension folder into a .lamplightext file (a .tar.gz) that Lamplight can install.
// Needs only Node.js 20+ and tar, so extension authors can copy it into their own project.
//
//   node pack-extension.mjs <folder> [--out <file>] [--sign <ed25519-private-key.pem>]
//
// <folder> holds manifest.json, the entry script (manifest.main) and everything it loads, including
// node_modules. The package gets CHECKSUMS (sha256 of every file), which Lamplight checks on install;
// with --sign it also gets SIGNATURE (Ed25519 over CHECKSUMS). Only packages signed with the Lamplight
// key count as official; others are installed after the user confirms. See docs/EXTENSIONS.md.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Packs `folder` into `out`; returns the number of files. Source maps are left out. */
export function packExtension(folder, out, { signingKey } = {}) {
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  for (const key of ["id", "name", "version", "type", "main", "platforms", "lamplightApi"]) {
    if (manifest[key] === undefined) throw new Error(`manifest.json: "${key}" is missing`);
  }
  const stage = mkdtempSync(join(tmpdir(), "lamplight-pack-"));
  try {
    cpSync(folder, stage, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.endsWith(".map") });
    rmSync(join(stage, "CHECKSUMS"), { force: true });
    rmSync(join(stage, "SIGNATURE"), { force: true });
    // npm's command shims are symbolic links and never needed at runtime
    rmSync(join(stage, "node_modules", ".bin"), { recursive: true, force: true });

    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = lstatSync(path);
        if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed in extensions: ${relative(stage, path)}`);
        if (st.isDirectory()) walk(path);
        else files.push(relative(stage, path).split("\\").join("/"));
      }
    };
    walk(stage);
    files.sort();
    const checksums = files
      .map((f) => `${createHash("sha256").update(readFileSync(join(stage, f))).digest("hex")}  ${f}`)
      .join("\n") + "\n";
    writeFileSync(join(stage, "CHECKSUMS"), checksums);
    if (signingKey) {
      const signature = sign(null, Buffer.from(checksums), createPrivateKey(readFileSync(signingKey)));
      writeFileSync(join(stage, "SIGNATURE"), signature.toString("base64") + "\n");
    }

    mkdirSync(dirname(resolve(out)), { recursive: true });
    rmSync(out, { force: true });
    execFileSync("tar", ["-czf", resolve(out), "-C", stage, "."], { stdio: "inherit" });
    return files.length;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const [, value] = args.splice(i, 2);
    if (!value) throw new Error(`${name} needs a value`);
    return value;
  };
  const out = option("--out");
  const signingKey = option("--sign");
  const folder = args[0];
  if (!folder) {
    console.error("usage: node pack-extension.mjs <folder> [--out <file>] [--sign <private-key.pem>]");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  const target = out ?? `${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.lamplightext`;
  const count = packExtension(folder, target, { signingKey });
  const sha = createHash("sha256").update(readFileSync(target)).digest("hex");
  console.log(`${target}  (${count} files${signingKey ? ", signed" : ", unsigned"})\nsha256 ${sha}`);
}
