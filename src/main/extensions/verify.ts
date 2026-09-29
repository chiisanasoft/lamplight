import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { EXTENSION_PUBLIC_KEY } from "./publicKey";

const META = new Set(["CHECKSUMS", "SIGNATURE"]);

/** Result of checking an unpacked extension. */
export interface VerifiedExtension {
  /** Signed with the Lamplight extension key (published by the Lamplight developers) */
  official: boolean;
}

/**
 * Checks an unpacked extension: the folder must contain exactly the files CHECKSUMS lists,
 * unchanged, with no symbolic links. Anyone can build an extension, so a signature is optional;
 * `official` reports whether SIGNATURE is a valid Ed25519 signature of CHECKSUMS by the Lamplight
 * extension key. Other packages are installed only after the user confirms.
 */
export function verifyExtensionDir(dir: string, publicKeyPem = EXTENSION_PUBLIC_KEY): VerifiedExtension {
  let checksums: Buffer;
  try {
    checksums = readFileSync(join(dir, "CHECKSUMS"));
  } catch {
    throw new Error("CHECKSUMS がありません。Lamplight の拡張機能のパッケージではありません。");
  }
  let official = false;
  try {
    const signature = Buffer.from(readFileSync(join(dir, "SIGNATURE"), "utf8").trim(), "base64");
    official = verify(null, checksums, createPublicKey(publicKeyPem), signature);
  } catch {
    /* unsigned, or signed by someone else */
  }

  const expected = new Map<string, string>();
  for (const line of checksums.toString("utf8").split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m || m[2].split("/").includes("..") || m[2].startsWith("/")) throw new Error("CHECKSUMS の形式が正しくありません");
    expected.set(m[2], m[1]);
  }

  const seen = new Set<string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const rel = relative(dir, path).split(sep).join("/");
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`拡張機能にシンボリックリンクは含められません: ${rel}`);
      if (st.isDirectory()) {
        walk(path);
        continue;
      }
      if (META.has(rel)) continue;
      const hash = expected.get(rel);
      if (!hash) throw new Error(`CHECKSUMS にないファイルがあります: ${rel}`);
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
        throw new Error(`ファイルが改ざんされています: ${rel}`);
      }
      seen.add(rel);
    }
  };
  walk(dir);
  for (const rel of expected.keys()) if (!seen.has(rel)) throw new Error(`ファイルが足りません: ${rel}`);
  return { official };
}
