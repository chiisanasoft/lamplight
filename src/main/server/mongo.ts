import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { net } from "electron";
import { freePort, killStale, waitForPort, writePid } from "./process";

const execFileAsync = promisify(execFile);

export interface MongoDownload {
  url: string;
  /** Directory name inside the archive */
  folder: string;
}

/**
 * Official MongoDB Community Server archives. They are downloaded on the user's machine on
 * first run instead of being bundled, so Lamplight does not redistribute SSPL-licensed binaries.
 */
export function mongoDownload(
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
  /** Contents of /etc/os-release (Linux); read from the system when omitted */
  osRelease?: string,
): MongoDownload | null {
  if (platform === "darwin") {
    const a = arch === "arm64" ? "arm64" : "x86_64";
    return {
      url: `https://fastdl.mongodb.org/osx/mongodb-macos-${a}-${version}.tgz`,
      folder: `mongodb-macos-${arch === "arm64" ? "aarch64" : "x86_64"}--${version}`,
    };
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    const target = linuxTarget(osRelease ?? readOsRelease(), arch);
    if (!target) return null;
    const name = `mongodb-linux-${arch === "arm64" ? "aarch64" : "x86_64"}-${target}-${version}`;
    return { url: `https://fastdl.mongodb.org/linux/${name}.tgz`, folder: name };
  }
  return null;
}

function readOsRelease(): string {
  for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      /* try the next location */
    }
  }
  return "";
}

/**
 * MongoDB's Linux build for this distribution (the name used in its archive names), from the
 * contents of /etc/os-release. Derivatives follow their base (Linux Mint → Ubuntu, Rocky → RHEL);
 * releases newer than the newest build use that build. null when there is no suitable build.
 */
export function linuxTarget(osRelease: string, arch: string): string | null {
  const field = (key: string) => new RegExp(`^${key}="?([^"\n]*)"?$`, "m").exec(osRelease)?.[1]?.trim().toLowerCase() ?? "";
  const ids = [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);
  const major = (v: string) => Number.parseFloat(v) || 0;
  const codename = field("UBUNTU_CODENAME");
  const ubuntuCodenames: Record<string, number> = { focal: 20.04, jammy: 22.04, noble: 24.04 };

  if (codename || ids.includes("ubuntu")) {
    const version = ubuntuCodenames[codename] ?? (field("ID") === "ubuntu" ? major(field("VERSION_ID")) : 24.04);
    if (version >= 24.04) return "ubuntu2404";
    if (version >= 22.04) return "ubuntu2204";
    return version >= 20.04 ? "ubuntu2004" : null;
  }
  if (ids.includes("debian")) {
    if (major(field("VERSION_ID")) < 12) return null;
    // No arm64 build for Debian; Ubuntu 22.04's needs an older glibc and the same OpenSSL 3
    return arch === "arm64" ? "ubuntu2204" : "debian12";
  }
  if (field("ID") === "amzn") return major(field("VERSION_ID")) >= 2023 ? "amazon2023" : null;
  if (ids.some((id) => id === "rhel" || id === "fedora" || id === "centos")) {
    if (field("ID") === "fedora") return "rhel93";
    const version = major(field("VERSION_ID"));
    if (version >= 9) return "rhel93";
    return version >= 8 ? "rhel8" : null;
  }
  return null;
}

export const MONGODB_LICENSE_URL = "https://www.mongodb.com/legal/licensing/server-side-public-license";

export class MongoManager {
  private proc: ChildProcess | null = null;
  readonly binDir: string;
  readonly dbPath: string;
  private readonly pidFile: string;

  constructor(private readonly dataDir: string, private readonly version: string, private readonly logDir: string) {
    this.binDir = join(dataDir, "mongodb", version);
    this.dbPath = join(dataDir, "mongodb", "data");
    this.pidFile = join(dataDir, "mongodb", "mongod.pid");
  }

  get mongod(): string {
    return join(this.binDir, "bin", "mongod");
  }

  isInstalled(): boolean {
    return existsSync(this.mongod);
  }

  isSupported(): boolean {
    return mongoDownload(this.version) !== null;
  }

  /** Downloads and verifies the official archive, then extracts mongod. */
  async install(onProgress: (fraction: number) => void): Promise<void> {
    const dl = mongoDownload(this.version);
    if (!dl) throw new Error("この OS では内蔵データベースにまだ対応していません");
    const work = join(this.dataDir, "mongodb", "download");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    const expected = (await (await net.fetch(`${dl.url}.sha256`)).text()).trim().split(/\s+/)[0];
    const res = await net.fetch(dl.url);
    if (!res.ok || !res.body) throw new Error(`MongoDB の取得に失敗しました（HTTP ${res.status}）`);
    const total = Number(res.headers.get("content-length")) || 0;
    const archive = join(work, "mongodb.tgz");
    const out = createWriteStream(archive);
    const hash = createHash("sha256");
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
      if (total) onProgress(received / total);
    }
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
    if (hash.digest("hex") !== expected) throw new Error("MongoDB のファイルが破損しています（SHA-256 が一致しません）");

    await execFileAsync("tar", ["xzf", archive, "-C", work]);
    rmSync(this.binDir, { recursive: true, force: true });
    mkdirSync(join(this.dataDir, "mongodb"), { recursive: true });
    renameSync(join(work, dl.folder), this.binDir);
    rmSync(work, { recursive: true, force: true });
  }

  /** Starts mongod on a free loopback port and returns its connection string. */
  async start(): Promise<string> {
    killStale(this.pidFile, "mongod");
    mkdirSync(this.dbPath, { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
    const port = await freePort();
    const log = openSync(join(this.logDir, "mongod.log"), "w");
    this.proc = spawn(this.mongod, ["--dbpath", this.dbPath, "--bind_ip", "127.0.0.1", "--port", String(port), "--quiet"], {
      stdio: ["ignore", log, log],
    });
    writePid(this.pidFile, this.proc.pid);
    const exited = new Promise<never>((_, reject) =>
      this.proc?.once("exit", (code) => reject(new Error(`MongoDB が終了しました（code ${code}）。${this.logHint()}`))),
    );
    await Promise.race([waitForPort(port, 30_000), exited]);
    return `mongodb://127.0.0.1:${port}/Lamplight`;
  }

  private logHint(): string {
    try {
      const lines = readFileSync(join(this.logDir, "mongod.log"), "utf8").trim().split("\n");
      return `ログ: ${lines.slice(-1)[0]?.slice(0, 200) ?? ""}`;
    } catch {
      return "";
    }
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
      p.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      p.kill("SIGTERM");
    });
    rmSync(this.pidFile, { force: true });
  }
}
