import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { net } from "electron";
import { killStale, writePid } from "./process";

const HEALTH_TIMEOUT_MS = 120_000;

/** Runs LibreChat's api server with Electron's bundled Node.js (ELECTRON_RUN_AS_NODE). */
export class LibreChatProcess {
  private proc: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private stopping = false;

  constructor(
    private readonly serverRoot: string,
    private readonly logDir: string,
    private readonly pidFile: string,
  ) {}

  /** Runs a LibreChat maintenance script (e.g. config/create-user.js) to completion. */
  runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [join(this.serverRoot, script), ...args], { cwd: this.serverRoot, env });
      let output = "";
      p.stdout?.on("data", (d) => (output += d));
      p.stderr?.on("data", (d) => (output += d));
      p.on("exit", (code) => resolve({ code: code ?? 1, output }));
    });
  }

  async start(env: Record<string, string>, onUnexpectedExit: (code: number | null) => void): Promise<void> {
    killStale(this.pidFile, "api/server/index.js");
    mkdirSync(this.logDir, { recursive: true });
    this.log = createWriteStream(join(this.logDir, "server.log"), { flags: "w" });
    this.stopping = false;

    const proc = spawn(process.execPath, [join(this.serverRoot, "api", "server", "index.js")], {
      cwd: this.serverRoot,
      env,
    });
    this.proc = proc;
    writePid(this.pidFile, proc.pid);
    proc.stdout?.pipe(this.log, { end: false });
    proc.stderr?.pipe(this.log, { end: false });

    let exitedEarly: ((err: Error) => void) | null = null;
    proc.on("exit", (code) => {
      exitedEarly?.(new Error(`Lamplight サーバーが起動中に終了しました（code ${code}）。ログ: ${join(this.logDir, "server.log")}`));
      if (!this.stopping) onUnexpectedExit(code);
    });

    const origin = `http://127.0.0.1:${env.PORT}`;
    await Promise.race([
      waitHealthy(origin, HEALTH_TIMEOUT_MS),
      new Promise<never>((_, reject) => (exitedEarly = reject)),
    ]);
    exitedEarly = null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => p.kill("SIGKILL"), 10_000);
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

async function waitHealthy(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await net.fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Lamplight サーバーの起動がタイムアウトしました");
}
