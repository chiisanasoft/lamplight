import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {} }));
const { parseManifest } = await import("../src/main/extensions/manifest");
const { verifyExtensionDir } = await import("../src/main/extensions/verify");
const { sanitizeConfig } = await import("../src/main/config");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Writes files plus CHECKSUMS/SIGNATURE the way scripts/build-extension.mjs does. */
function makePackage(files: Record<string, string>, key = privateKey) {
  const dir = mkdtempSync(join(tmpdir(), "lamplight-ext-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const checksums = Object.keys(files).sort()
    .map((f) => `${createHash("sha256").update(files[f]).digest("hex")}  ${f}`).join("\n") + "\n";
  writeFileSync(join(dir, "CHECKSUMS"), checksums);
  writeFileSync(join(dir, "SIGNATURE"), sign(null, Buffer.from(checksums), key).toString("base64"));
  return dir;
}

const files = { "manifest.json": "{}", "dist/server.js": "console.log(1)" };

/** Same as makePackage but without SIGNATURE, as a third-party developer may ship it. */
function makeUnsignedPackage(files: Record<string, string>) {
  const dir = makePackage(files);
  rmSync(join(dir, "SIGNATURE"));
  return dir;
}

describe("verifyExtensionDir", () => {
  it("marks a package signed with the Lamplight key as official", () => {
    expect(verifyExtensionDir(makePackage(files), pub)).toEqual({ official: true });
  });

  it("accepts packages by other developers as not official", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(verifyExtensionDir(makePackage(files, other), pub)).toEqual({ official: false });
    expect(verifyExtensionDir(makeUnsignedPackage(files), pub)).toEqual({ official: false });
  });

  it("rejects a modified file, signed or not", () => {
    for (const dir of [makePackage(files), makeUnsignedPackage(files)]) {
      writeFileSync(join(dir, "dist/server.js"), "evil()");
      expect(() => verifyExtensionDir(dir, pub)).toThrow(/改ざん/);
    }
  });

  it("rejects an added file or a symlink", () => {
    const dir = makePackage(files);
    writeFileSync(join(dir, "dist/extra.js"), "evil()");
    expect(() => verifyExtensionDir(dir, pub)).toThrow(/CHECKSUMS にないファイル/);
    const dir2 = makePackage(files);
    symlinkSync("/etc/hosts", join(dir2, "dist/link"));
    expect(() => verifyExtensionDir(dir2, pub)).toThrow(/シンボリックリンク/);
  });

  it("rejects a folder without CHECKSUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamplight-ext-"));
    writeFileSync(join(dir, "manifest.json"), "{}");
    expect(() => verifyExtensionDir(dir, pub)).toThrow(/CHECKSUMS がありません/);
  });
});

describe("parseManifest", () => {
  const base = { id: "ocr", name: "OCR", version: "0.1.0", lamplightApi: 1, type: "ollama-proxy", main: "dist/server.js", platforms: ["darwin-arm64"] };

  it("accepts the OCR manifest shape", () => {
    expect(parseManifest({ ...base, settings: [{ key: "k", label: "L", type: "text", default: "x" }] }).settings).toHaveLength(1);
  });

  it("rejects unsafe or incompatible manifests", () => {
    expect(() => parseManifest({ ...base, main: "../escape.js" })).toThrow();
    expect(() => parseManifest({ ...base, id: "Bad Id" })).toThrow();
    expect(() => parseManifest({ ...base, type: "anything" })).toThrow();
    expect(() => parseManifest({ ...base, lamplightApi: 2 })).toThrow(/別のバージョン/);
  });
});

describe("extension settings in config", () => {
  it("moves v0.3 OCR settings into the ocr extension, disabled until it is installed", () => {
    const c = sanitizeConfig({ ocrFormatModel: "nemotron", ocrTemplate: "日付,住所" });
    expect(c.extensions.ocr).toEqual({ enabled: false, settings: { formatLlm: "nemotron", template: "日付,住所" } });
  });

  it("keeps valid extension state only", () => {
    const c = sanitizeConfig({ extensions: { ocr: { enabled: true, settings: { a: "1", b: 2 }, port: 40000 }, "Bad Id": {} } });
    expect(c.extensions).toEqual({ ocr: { enabled: true, settings: { a: "1" }, port: 40000 } });
  });
});
