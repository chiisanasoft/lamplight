import type { Secrets } from "./secrets";

export const LOCAL_ACCOUNT = { email: "local@lamplight.localhost", username: "lamplight" };
export const OLLAMA_URL = "http://127.0.0.1:11434";

export interface ServerDirs {
  logs: string;
  uploads: string;
  images: string;
  /** LibreChat's publicPath; uploaded images live in its images/ folder, which must be `images` above */
  publicDir: string;
  configPath: string;
  serverEnvPath: string;
  tempCredentials: string;
}

/** Parses dotenv text (KEY=value, quoted values, trailing " # comments"). Empty values are dropped. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    }
    if (value) out[m[1]] = value;
  }
  return out;
}

/**
 * Environment for the embedded LibreChat server, layered like a LibreChat install:
 *
 * 1. LibreChat's own defaults (.env.example), so the app behaves like a stock LibreChat — e.g.
 *    OpenAI, Anthropic and Google accept user-provided API keys from the UI
 * 2. Lamplight's defaults (title, no search index, …)
 * 3. The user's server.env, the equivalent of LibreChat's .env
 * 4. Values the embedded server depends on (address, database, secrets, data paths); these always win
 *
 * The user's shell environment is not inherited (NODE_OPTIONS, proxies, …), apart from a few basics.
 */
export function serverEnv(opts: {
  port: number;
  mongoUri: string;
  secrets: Secrets;
  dirs: ServerDirs;
  librechatDefaults?: Record<string, string>;
  userEnv?: Record<string, string>;
  /** Base URL of the Ollama endpoint (the OCR proxy), referenced from librechat.yaml */
  ollamaUrl?: string;
  /** Extra values the embedded server depends on (e.g. an extension's OCR service address) */
  extra?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { port, mongoUri, secrets, dirs } = opts;
  const base = opts.base ?? process.env;
  const origin = `http://127.0.0.1:${port}`;
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL"];
  return {
    ...Object.fromEntries(keep.filter((k) => base[k]).map((k) => [k, base[k] as string])),
    ...opts.librechatDefaults,
    // Lamplight defaults, overridable in server.env
    SEARCH: "false",
    APP_TITLE: "Lamplight",
    CUSTOM_FOOTER: "",
    ALLOW_EMAIL_LOGIN: "true",
    ALLOW_UNVERIFIED_EMAIL_LOGIN: "true",
    ALLOW_SOCIAL_LOGIN: "false",
    NO_PROXY: "localhost,127.0.0.1,::1",
    ...opts.userEnv,
    // Required by the embedded server
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DOMAIN_CLIENT: origin,
    DOMAIN_SERVER: origin,
    MONGO_URI: mongoUri,
    CREDS_KEY: secrets.credsKey,
    CREDS_IV: secrets.credsIv,
    JWT_SECRET: secrets.jwtSecret,
    JWT_REFRESH_SECRET: secrets.jwtRefreshSecret,
    // Single local account created by Lamplight; nobody else can sign up
    ALLOW_REGISTRATION: "false",
    ALLOW_SOCIAL_REGISTRATION: "false",
    SCHEDULES_SINGLE_PROCESS: "true",
    CONFIG_PATH: dirs.configPath,
    LIBRECHAT_LOG_DIR: dirs.logs,
    LAMPLIGHT_UPLOADS_DIR: dirs.uploads,
    LAMPLIGHT_IMAGES_DIR: dirs.images,
    LAMPLIGHT_PUBLIC_DIR: dirs.publicDir,
    LIBRECHAT_TEMP_CREDENTIALS_PATH: dirs.tempCredentials,
    [OLLAMA_URL_ENV]: opts.ollamaUrl ?? `${OLLAMA_URL}/v1/`,
    ...opts.extra,
  };
}

/** Starter server.env: LibreChat's .env settings the user may add. */
export const SERVER_ENV_TEMPLATE = `# Lamplight 内蔵サーバーの設定（LibreChat の .env と同じ書き方）
# 変更は Lamplight の再起動後に反映されます。
#
# 既定では OpenAI・Anthropic（Claude）・Google（Gemini）の API キーは、各自がチャット画面の
# モデル選択にある歯車アイコンから入力します（user_provided）。
# サーバー全体で共通のキーを使う場合は、次の行の先頭の # を外してキーを書きます。
#
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_KEY=...
#
# ほかに使える設定は LibreChat のドキュメントを参照してください:
# https://www.librechat.ai/docs/configuration/dotenv
#
# 次の項目は Lamplight が管理するため、ここで設定しても反映されません:
# HOST, PORT, DOMAIN_CLIENT, DOMAIN_SERVER, MONGO_URI, CREDS_KEY, CREDS_IV,
# JWT_SECRET, JWT_REFRESH_SECRET, ALLOW_REGISTRATION, CONFIG_PATH
`;

/**
 * Replaces (or adds / removes) a top-level block Lamplight manages in librechat.yaml, delimited by
 * "# >>> lamplight: <name>" and "# <<< lamplight: <name>" lines. The rest of the file is untouched.
 */
export function setManagedBlock(yaml: string, name: string, block: string | null): string {
  const begin = `# >>> lamplight: ${name}`;
  const end = `# <<< lamplight: ${name}`;
  const re = new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  const without = yaml.replace(re, "\n").replace(/\n{3,}$/, "\n\n");
  if (block === null) return without.replace(/\n+$/, "\n");
  return `${without.replace(/\n+$/, "")}\n\n${begin}\n${block.trim()}\n${end}\n`;
}

/** OCR service block: LibreChat reads uploaded documents through an extension's Mistral OCR–compatible API. */
export const OCR_BASEURL_ENV = "LAMPLIGHT_OCR_BASEURL";
export const OCR_API_KEY_ENV = "LAMPLIGHT_OCR_API_KEY";
export function ocrServiceBlock(model: string, port: number): string {
  return `# Documents uploaded as text are read by a Lamplight extension (managed by Lamplight)
ocr:
  strategy: "mistral_ocr"
  # The extension listens on loopback, which LibreChat's SSRF guard blocks unless listed
  allowedAddresses:
    - '127.0.0.1:${port}'
  baseURL: "\${${OCR_BASEURL_ENV}}"
  apiKey: "\${${OCR_API_KEY_ENV}}"
  mistralModel: "${model}"`;
}

/** Marks the allowedAddresses entry Lamplight keeps pointed at the current Ollama address (a proxy extension or Ollama itself). */
const PROXY_MARKER = "# lamplight-ocr-proxy";
/** The Ollama endpoint's baseURL; LibreChat resolves ${VAR} values from the environment. */
export const OLLAMA_URL_ENV = "LAMPLIGHT_OLLAMA_URL";

/**
 * Files LibreChat may hand to the Ollama endpoint. Documents uploaded as text are stored as
 * text/plain; without it LibreChat drops them from the message before it is sent.
 */
const OLLAMA_MIME_TYPES = `      supportedMimeTypes:
        - "image/.*"
        - "application/pdf"
        - "text/plain"
`;

/**
 * Ollama's OpenAI-compatible API rejects PDF file parts, so PDFs are sent to the model as their
 * text (read by LibreChat's document parser, or by an OCR extension when one is enabled).
 * Used from LibreChat v0.8.8, which chooses how each attachment is delivered.
 */
const PDF_AS_TEXT = `      defaultLLMDeliveryPath:
        overrides:
          "application/pdf": "text"
`;

/**
 * Starter librechat.yaml for the embedded server. Ollama's address comes from ${LAMPLIGHT_OLLAMA_URL}:
 * Ollama itself, or a proxy extension such as OCR in front of it. `ollamaPort` is that address's port.
 */
export function librechatYaml(ollamaPort: number): string {
  const host = new URL(OLLAMA_URL).host;
  return `# Lamplight 内蔵サーバーの LibreChat 設定（librechat.yaml）
# Lamplight が初回に作成しました。自由に編集できます（変更は再起動後に反映）。
# 書き方: https://www.librechat.ai/docs/configuration/librechat_yaml
version: 1.3.13
cache: true

endpoints:
  # Loopback addresses allowed through LibreChat's SSRF guard
  allowedAddresses:
    - '${host}'
    - '127.0.0.1:${ollamaPort}'  ${PROXY_MARKER}
  custom:
    - name: "Ollama"
      apiKey: "ollama"
      # Ollama, or a Lamplight extension in front of it (set by Lamplight on each start)
      baseURL: "\${${OLLAMA_URL_ENV}}"
      models:
        default: ["qwen3.5:9b"]
        fetch: true
      titleConvo: true
      titleModel: "current_model"
      modelDisplayLabel: "Ollama"

fileConfig:
  endpoints:
    Ollama:
${OLLAMA_MIME_TYPES}${PDF_AS_TEXT}`;
}

/**
 * Points an existing librechat.yaml at the OCR proxy: updates the proxy's allowed address to the
 * current port, and upgrades unmodified blocks written by older versions (v0.2: direct to Ollama,
 * images only; v0.4: text uploads dropped, PDFs sent to Ollama as file parts).
 * A file the user rewrote is left alone; `wired` then reports whether Ollama goes through the proxy.
 */
export function wireOcrProxy(yaml: string, ocrPort: number): { yaml: string; wired: boolean } {
  let out = yaml.replace(new RegExp(`'127\\.0\\.0\\.1:\\d+'(\\s*)${PROXY_MARKER}`), `'127.0.0.1:${ocrPort}'$1${PROXY_MARKER}`);
  const v02BaseUrl = `baseURL: "${OLLAMA_URL}/v1/"`;
  if (out.includes(v02BaseUrl)) {
    out = out.replace(v02BaseUrl, `baseURL: "\${${OLLAMA_URL_ENV}}"`);
    out = out.replace(/^(\s*)allowedAddresses:\s*\n/m, (m, indent: string) => `${m}${indent}  - '127.0.0.1:${ocrPort}'  ${PROXY_MARKER}\n`);
    out = out.replace(/(\n(\s*)- "image\/\.\*"\n)(?![\s\S]*application\/pdf)/, `$1$2- "application/pdf"\n`);
  }
  // Up to v0.4 the starter file left out text uploads and PDF delivery
  const v04MimeTypes = `    Ollama:\n      supportedMimeTypes:\n        - "image/.*"\n        - "application/pdf"\n`;
  const at = out.indexOf(v04MimeTypes);
  const rest = at === -1 ? "" : out.slice(at + v04MimeTypes.length);
  if (at !== -1 && !rest.startsWith(`        - "text/plain"\n`)) {
    const delivery = rest.startsWith(PDF_AS_TEXT) || out.includes("defaultLLMDeliveryPath") ? "" : PDF_AS_TEXT;
    out = out.replace(v04MimeTypes, `    Ollama:\n${OLLAMA_MIME_TYPES}${delivery}`);
  }
  return { yaml: out, wired: out.includes(`\${${OLLAMA_URL_ENV}}`) && out.includes(PROXY_MARKER) };
}

/** Models that cannot hold a normal conversation (OCR, embeddings, rerankers). */
const NON_CHAT_MODEL = /ocr|embed|rerank/i;

/**
 * Model to preselect on first run: the first chat-capable one, so a fresh install does not
 * open on an OCR model just because it sorts first.
 */
export function preferredChatModel(models: string[]): string | undefined {
  return models.find((m) => !NON_CHAT_MODEL.test(m));
}
