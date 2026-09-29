import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { net } from "electron";
import { CATALOG, type CatalogEntry } from "./catalog";
import { currentPlatform, parseManifest, type ExtensionManifest } from "./manifest";
import { verifyExtensionDir } from "./verify";

const execFileAsync = promisify(execFile);

/** Thrown when the user declines to install an extension that is not official. */
export class InstallCanceled extends Error {}

/** Asked before installing an extension without the Lamplight signature; resolve true to install. */
export type ConfirmUnofficial = (manifest: ExtensionManifest) => Promise<boolean>;

export interface InstalledExtension {
  manifest: ExtensionManifest;
  dir: string;
}

/** Installs, lists and removes extensions under <userData>/extensions/<id>. */
export class ExtensionManager {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "extensions");
  }

  installed(): InstalledExtension[] {
    if (!existsSync(this.root)) return [];
    const out: InstalledExtension[] = [];
    for (const id of readdirSync(this.root)) {
      if (id.startsWith(".")) continue;
      const dir = join(this.root, id);
      try {
        out.push({ manifest: parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))), dir });
      } catch {
        /* unreadable leftovers are ignored */
      }
    }
    return out;
  }

  get(id: string): InstalledExtension | undefined {
    return this.installed().find((e) => e.manifest.id === id);
  }

  catalog(): CatalogEntry[] {
    return CATALOG;
  }

  /**
   * Unpacks a .lamplightext file, checks every file against CHECKSUMS, then installs it. Packages
   * not signed by the Lamplight developers are installed only when `confirm` agrees.
   */
  async installFromFile(file: string, confirm: ConfirmUnofficial): Promise<{ manifest: ExtensionManifest; official: boolean }> {
    const staging = mkdtempSync(join(this.ensureRoot(), ".install-"));
    try {
      await execFileAsync("tar", ["-xzf", file, "-C", staging]);
      const { official } = verifyExtensionDir(staging);
      const manifest = parseManifest(JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")));
      if (!manifest.platforms.includes(currentPlatform())) {
        throw new Error(`この拡張機能は ${currentPlatform()} に対応していません（対応: ${manifest.platforms.join(", ")}）`);
      }
      if (!existsSync(join(staging, manifest.main))) throw new Error(`拡張機能の本体 ${manifest.main} がありません`);
      if (!official && !(await confirm(manifest))) throw new InstallCanceled();
      const target = join(this.root, manifest.id);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      return { manifest, official };
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /** Downloads a catalog extension for this platform and installs it. */
  async installFromCatalog(
    id: string,
    onProgress: (fraction: number) => void,
    confirm: ConfirmUnofficial,
  ): Promise<{ manifest: ExtensionManifest; official: boolean }> {
    const entry = CATALOG.find((e) => e.id === id);
    const url = entry?.downloads[currentPlatform()];
    if (!entry || !url) throw new Error("この拡張機能は、まだこの OS 向けに配布されていません");
    const tmp = join(this.ensureRoot(), `.download-${id}.lamplightext`);
    const res = await net.fetch(url);
    if (res.status === 404) throw new Error("配布元にファイルが見つかりません。配布元がまだ公開されていない可能性があります（HTTP 404）");
    if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）`);
    const total = Number(res.headers.get("content-length")) || 0;
    const out = createWriteStream(tmp);
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
      if (total) onProgress(received / total);
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    try {
      return await this.installFromFile(tmp, confirm);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  uninstall(id: string) {
    rmSync(join(this.root, id), { recursive: true, force: true });
  }

  private ensureRoot(): string {
    mkdirSync(this.root, { recursive: true });
    return this.root;
  }
}
