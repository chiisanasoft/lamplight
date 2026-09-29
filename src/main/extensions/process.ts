import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { killStale, writePid } from "../server/process";

/** Config handed to an extension in LAMPLIGHT_EXT_CONFIG. */
export interface ExtensionRuntimeConfig {
  /** Loopback port the extension listens on */
  port: number;
  /** Ollama base URL (no trailing slash) */
  upstream: string;
  /** Writable folder for the extension's own data */
  dataDir: string;
  settings: Record<string, string>;
  /** Per-launch secret the extension can require from LibreChat (e.g. for an OCR service) */
  token: string;
}

const READY_TIMEOUT_MS = 20_000;

/**
 * Runs an extension's entry script as a child process on Electron's Node.js, off the UI thread.
 * A utility process is not used: libraries such as pdf.js treat it as a browser. The extension
 * signals readiness with process.send().
 */
export class ExtensionProcess {
  private proc: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private stopping = false;

  constructor(
    private readonly entry: string,
    private readonly logFile: string,
    private readonly pidFile: string,
  ) {}

  async start(cfg: ExtensionRuntimeConfig, onUnexpectedExit: (code: number | null) => void): Promise<void> {
    killStale(this.pidFile, this.entry);
    mkdirSync(dirname(this.logFile), { recursive: true });
    mkdirSync(cfg.dataDir, { recursive: true });
    this.log = createWriteStream(this.logFile, { flags: "w" });
    this.stopping = false;
    const proc = spawn(process.execPath, [this.entry], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ELECTRON_RUN_AS_NODE: "1",
        LAMPLIGHT_EXT_CONFIG: JSON.stringify(cfg),
      },
    });
    this.proc = proc;
    writePid(this.pidFile, proc.pid);
    proc.stdout?.pipe(this.log, { end: false });
    proc.stderr?.pipe(this.log, { end: false });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("拡張機能の起動がタイムアウトしました")), READY_TIMEOUT_MS);
      proc.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`拡張機能が起動中に終了しました（code ${code}）。ログ: ${this.logFile}`));
      });
    });
    proc.on("exit", (code) => {
      if (!this.stopping) onUnexpectedExit(code);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          p.kill("SIGKILL");
          resolve();
        }, 5000);
        p.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        p.kill("SIGTERM");
      });
    }
    rmSync(this.pidFile, { force: true });
    this.log?.end();
  }
}
