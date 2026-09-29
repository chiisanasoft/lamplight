import { net } from "electron";

export type ServerState = "unknown" | "online" | "offline";

/** Polls LibreChat's /health endpoint and reports changes. */
export class ServerStatus {
  state: ServerState = "unknown";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverUrl: () => string,
    private readonly onChange: (state: ServerState) => void,
    private readonly intervalMs = 30_000,
  ) {}

  start() {
    this.stop();
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<ServerState> {
    const next = (await probe(this.serverUrl())) ? "online" : "offline";
    if (next !== this.state) {
      this.state = next;
      this.onChange(next);
    }
    return next;
  }
}

export async function probe(serverUrl: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await net.fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
