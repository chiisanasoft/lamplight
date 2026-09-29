import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { app, net, session } from "electron";
import type { InstalledExtension } from "../extensions/manager";
import { ExtensionProcess, type ExtensionRuntimeConfig } from "../extensions/process";
import { LibreChatProcess } from "./librechat";
import { MongoManager } from "./mongo";
import { freePort } from "./process";
import { SecretStore, SecretsUnreadableError, type Secrets } from "./secrets";
import { randomBytes } from "node:crypto";
import {
  LOCAL_ACCOUNT,
  OCR_API_KEY_ENV,
  OCR_BASEURL_ENV,
  ocrServiceBlock,
  setManagedBlock,
  OLLAMA_URL,
  SERVER_ENV_TEMPLATE,
  librechatYaml,
  parseDotenv,
  serverEnv,
  wireOcrProxy,
  type ServerDirs,
} from "./serverConfig";

export type StartupStep =
  | { step: "consent" }
  | { step: "download"; progress: number }
  | { step: "database" }
  | { step: "extensions" }
  | { step: "server" }
  | { step: "account" }
  | { step: "signin" }
  | { step: "ready"; url: string; ollama: boolean }
  | { step: "error"; message: string };

export interface EmbeddedOptions {
  /** Directory holding the staged LibreChat server (resources/server) */
  serverRoot: string;
  mongodbVersion: string;
  /** Port to reuse across launches so the login cookie and LibreChat's local settings persist */
  preferredPort?: number;
  onPortChosen(port: number): void;
  /**
   * Enabled extension of type "ollama-proxy" (at most one), placed between LibreChat and Ollama.
   * Its port is kept across launches because it is written into librechat.yaml.
   */
  proxyExtension?: {
    extension: InstalledExtension;
    settings: Record<string, string>;
    preferredPort?: number;
    onPortChosen(port: number): void;
  };
  onStep(step: StartupStep): void;
  /**
   * Asked when secrets.bin cannot be decrypted. Resolving true makes new secrets and resets the
   * local account's password; conversations stay, saved API keys must be entered again.
   */
  confirmSecretsReset(): Promise<boolean>;
  /** Resolves once the user agrees to download MongoDB (first run only) */
  requestConsent(): Promise<void>;
  onCrash(message: string): void;
}

/** Runs the whole local stack: MongoDB → LibreChat server → local account → signed-in session. */
export class EmbeddedServer {
  private readonly dataDir = app.getPath("userData");
  private readonly dirs: ServerDirs;
  private readonly mongo: MongoManager;
  private readonly server: LibreChatProcess;
  private proxy: ExtensionProcess | null = null;
  /** Id of the extension started with this server (enabling another one takes effect on restart) */
  runningProxyId: string | null = null;
  private proxyConfig: ExtensionRuntimeConfig | null = null;
  private readonly secrets = new SecretStore(join(this.dataDir, "secrets.bin"));
  url: string | null = null;
  /** True when this launch created the local account (first run) */
  firstRun = false;

  constructor(private readonly opts: EmbeddedOptions) {
    const d = this.dataDir;
    this.dirs = {
      logs: join(d, "logs"),
      uploads: join(d, "server-data", "uploads"),
      images: join(d, "server-data", "images"),
      publicDir: join(d, "server-data"),
      configPath: join(d, "librechat.yaml"),
      serverEnvPath: join(d, "server.env"),
      tempCredentials: join(d, "server-data", ".env.temp"),
    };
    this.mongo = new MongoManager(d, opts.mongodbVersion, this.dirs.logs);
    this.server = new LibreChatProcess(opts.serverRoot, this.dirs.logs, join(d, "server.pid"));
  }

  async start(partition: string): Promise<string> {
    const { onStep } = this.opts;
    try {
      if (!this.mongo.isSupported()) {
        throw new Error("この OS ではまだ内蔵サーバーに対応していません。設定で「外部サーバー」を選んでください。");
      }
      if (!this.mongo.isInstalled()) {
        onStep({ step: "consent" });
        await this.opts.requestConsent();
        onStep({ step: "download", progress: 0 });
        await this.mongo.install((progress) => onStep({ step: "download", progress }));
      }

      onStep({ step: "database" });
      const mongoUri = await this.mongo.start();

      for (const dir of [this.dirs.uploads, this.dirs.images, this.dirs.logs]) mkdirSync(dir, { recursive: true });

      // Without a proxy extension LibreChat talks to Ollama directly
      let ollamaUrl = `${OLLAMA_URL}/v1/`;
      let allowedPort = Number(new URL(OLLAMA_URL).port);
      const extraEnv: Record<string, string> = {};
      let ocrBlock: string | null = null;
      const proxy = this.opts.proxyExtension;
      if (proxy) {
        onStep({ step: "extensions" });
        const port = await freePort(proxy.preferredPort);
        proxy.onPortChosen(port);
        await this.startProxy(proxy.extension, proxy.settings, port);
        ollamaUrl = `http://127.0.0.1:${port}/v1/`;
        allowedPort = port;
        const ocr = proxy.extension.manifest.ocrService;
        if (ocr) {
          extraEnv[OCR_BASEURL_ENV] = `http://127.0.0.1:${port}${ocr.basePath}`;
          extraEnv[OCR_API_KEY_ENV] = this.proxyConfig!.token;
          ocrBlock = ocrServiceBlock(ocr.model, port);
        }
      }

      // Both files are the user's to edit, like LibreChat's .env and librechat.yaml
      if (!existsSync(this.dirs.configPath)) writeFileSync(this.dirs.configPath, librechatYaml(allowedPort));
      const { yaml, wired } = wireOcrProxy(readFileSync(this.dirs.configPath, "utf8"), allowedPort);
      writeFileSync(this.dirs.configPath, setManagedBlock(yaml, "ocr", ocrBlock));
      if (proxy && !wired) console.warn("[lamplight] librechat.yaml was customized; Ollama is not routed through the extension");
      if (!existsSync(this.dirs.serverEnvPath)) writeFileSync(this.dirs.serverEnvPath, SERVER_ENV_TEMPLATE);
      const secrets = await this.loadSecrets();
      const port = await freePort(this.opts.preferredPort);
      this.opts.onPortChosen(port);
      const env = serverEnv({
        port,
        mongoUri,
        secrets,
        dirs: this.dirs,
        librechatDefaults: readDotenv(join(this.opts.serverRoot, ".env.example")),
        userEnv: readDotenv(this.dirs.serverEnvPath),
        ollamaUrl,
        extra: extraEnv,
      });

      if (!secrets.localAccountCreated) {
        onStep({ step: "account" });
        await this.createLocalAccount(env, secrets.localPassword);
        this.secrets.save({ ...secrets, localAccountCreated: true });
        this.firstRun = true;
      }

      onStep({ step: "server" });
      await this.server.start(env, (code) => this.opts.onCrash(`Lamplight サーバーが停止しました（code ${code}）`));
      this.url = `http://127.0.0.1:${port}`;

      onStep({ step: "signin" });
      await this.signIn(partition);

      onStep({ step: "ready", url: this.url, ollama: await ollamaRunning() });
      return this.url;
    } catch (err) {
      onStep({ step: "error", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async createLocalAccount(env: Record<string, string>, password: string) {
    const name = displayName();
    const { code, output } = await this.server.runScript(
      join("config", "create-user.js"),
      [LOCAL_ACCOUNT.email, name, LOCAL_ACCOUNT.username, password, "--email-verified=true"],
      env,
    );
    if (code === 0) return;
    if (!/already exists/i.test(output)) {
      throw new Error(`ローカルアカウントを作成できませんでした: ${output.trim().split("\n").slice(-1)[0]}`);
    }
    // The account outlived the secrets it was made with: give it the new password
    const recovered = await this.server.runScript(
      join("config", "lamplight-recover-account.js"),
      [LOCAL_ACCOUNT.email, password],
      env,
    );
    if (recovered.code !== 0) {
      throw new Error(`ローカルアカウントを復旧できませんでした: ${recovered.output.trim().split("\n").slice(-1)[0]}`);
    }
  }

  /** Loads secrets.bin; when it cannot be decrypted, asks before replacing it with new secrets. */
  private async loadSecrets(): Promise<Secrets> {
    try {
      return this.secrets.load();
    } catch (err) {
      if (!(err instanceof SecretsUnreadableError)) throw err;
      if (!(await this.opts.confirmSecretsReset())) {
        throw new Error("保存済みの暗号鍵を読み込めないため、Lamplight サーバーを起動できません");
      }
      const kept = this.secrets.setAside();
      console.warn(`[lamplight] secrets.bin could not be decrypted (${err.message}); moved to ${kept}`);
      return this.secrets.load();
    }
  }

  /** Signs in inside the app's session so the LibreChat window opens already logged in. */
  async signIn(partition: string) {
    if (!this.url) return;
    const secrets = this.secrets.load();
    const res = await session.fromPartition(partition).fetch(`${this.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: LOCAL_ACCOUNT.email, password: secrets.localPassword }),
      credentials: "include",
    });
    if (!res.ok) throw new Error(`自動ログインに失敗しました（HTTP ${res.status}）`);
  }

  private async startProxy(extension: InstalledExtension, settings: Record<string, string>, port: number) {
    const { manifest, dir } = extension;
    this.proxy = new ExtensionProcess(join(dir, manifest.main), join(this.dirs.logs, `ext-${manifest.id}.log`), join(this.dataDir, `ext-${manifest.id}.pid`));
    this.runningProxyId = manifest.id;
    this.proxyConfig = {
      port,
      upstream: OLLAMA_URL,
      dataDir: join(this.dataDir, "extension-data", manifest.id),
      settings,
      // Kept across restartProxy() so LibreChat's copy stays valid
      token: this.proxyConfig?.token ?? randomBytes(24).toString("hex"),
    };
    await this.proxy.start(this.proxyConfig, (code) => this.opts.onCrash(`拡張機能「${manifest.name}」が停止しました（code ${code}）`));
  }

  /** Applies changed extension settings by restarting only the extension (same port). */
  async restartProxy(settings: Record<string, string>) {
    const proxy = this.opts.proxyExtension;
    if (!proxy || !this.proxyConfig || !this.proxy) return;
    proxy.settings = settings;
    await this.proxy.stop();
    await this.startProxy(proxy.extension, settings, this.proxyConfig.port);
  }

  /** Origin and download paths of the running proxy extension (for saving its file links). */
  get proxyDownloads(): { origin: string; paths: string[] } | null {
    const proxy = this.opts.proxyExtension;
    if (!proxy || !this.proxyConfig) return null;
    return { origin: `http://127.0.0.1:${this.proxyConfig.port}`, paths: proxy.extension.manifest.downloadPaths ?? [] };
  }

  async stop() {
    await this.server.stop();
    await this.proxy?.stop();
    this.runningProxyId = null;
    await this.mongo.stop();
  }
}

function readDotenv(path: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function displayName(): string {
  try {
    const n = userInfo().username;
    return n.length >= 3 ? n : "Lamplight User";
  } catch {
    return "Lamplight User";
  }
}

/** Models installed in the local Ollama (empty when it is not running). */
export async function ollamaModels(): Promise<string[]> {
  try {
    const res = await net.fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

export async function ollamaRunning(): Promise<boolean> {
  try {
    const res = await net.fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
