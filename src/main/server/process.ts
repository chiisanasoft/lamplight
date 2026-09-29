import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";

/** A free TCP port on the loopback interface. */
export function freePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (preferred && err.code === "EADDRINUSE") resolve(freePort());
      else reject(err);
    });
    srv.listen(preferred ?? 0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`127.0.0.1:${port} が応答しません`);
}

export function writePid(file: string, pid: number | undefined) {
  if (!pid) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(pid));
}

/**
 * Kills a process left over from a crash (recorded in `file`) if it is still alive
 * and its command line contains `marker`, so a stale mongod/server cannot hold the port or data lock.
 */
export function killStale(file: string, marker: string) {
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  rmSync(file, { force: true });
  if (!pid) return;
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (!cmd.includes(marker)) return;
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50; i++) {
      process.kill(pid, 0);
      execFileSync("sleep", ["0.2"]);
    }
    process.kill(pid, "SIGKILL");
  } catch {
    /* not running */
  }
}
