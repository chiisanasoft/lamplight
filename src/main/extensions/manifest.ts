/** Extension manifest (manifest.json at the root of an extension package). */

/** Version of the contract between Lamplight and extensions (config, start-up, kinds). */
export const LAMPLIGHT_EXTENSION_API = 1;

export interface ExtensionSetting {
  key: string;
  label: string;
  /** "ollama-model" renders a picker of installed Ollama models */
  type: "text" | "ollama-model";
  default: string;
  description?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  lamplightApi: number;
  /** "ollama-proxy": sits between LibreChat and Ollama as an OpenAI-compatible proxy */
  type: "ollama-proxy";
  /** Entry script, relative to the extension folder */
  main: string;
  /** "<platform>-<arch>" values the package can run on */
  platforms: string[];
  /** URL paths whose links the app saves as downloads (e.g. "/exports/") */
  downloadPaths?: string[];
  /**
   * The extension serves a Mistral OCR–compatible API under basePath; LibreChat then uses it to
   * read documents uploaded as text (including scanned PDFs).
   */
  ocrService?: { basePath: string; model: string };
  requires?: { ollamaModels?: string[] };
  settings?: ExtensionSetting[];
  license?: string;
  /** Who made the extension, shown in the list (e.g. a name or organization) */
  author?: string;
  /** Web page of the extension */
  homepage?: string;
}

export const currentPlatform = () => `${process.platform}-${process.arch}`;

/** Validates a parsed manifest.json; throws a user-facing message when it is not usable. */
export function parseManifest(raw: unknown): ExtensionManifest {
  const m = raw as Partial<ExtensionManifest>;
  const bad = (what: string) => new Error(`拡張機能のマニフェストが正しくありません（${what}）`);
  if (!m || typeof m !== "object") throw bad("形式");
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(m.id)) throw bad("id");
  if (typeof m.name !== "string" || !m.name.trim()) throw bad("name");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) throw bad("version");
  if (m.type !== "ollama-proxy") throw bad(`未対応の種類 ${String(m.type)}`);
  if (typeof m.main !== "string" || m.main.startsWith("/") || m.main.split("/").includes("..")) throw bad("main");
  if (!Array.isArray(m.platforms)) throw bad("platforms");
  if (m.lamplightApi !== LAMPLIGHT_EXTENSION_API) {
    throw new Error(`この拡張機能は Lamplight の別のバージョン向けです（API ${m.lamplightApi}、この Lamplight は ${LAMPLIGHT_EXTENSION_API}）`);
  }
  const settings = (m.settings ?? []).filter(
    (s) => s && typeof s.key === "string" && typeof s.label === "string" && (s.type === "text" || s.type === "ollama-model"),
  );
  return {
    id: m.id,
    name: m.name.trim(),
    version: m.version,
    description: typeof m.description === "string" ? m.description : "",
    lamplightApi: m.lamplightApi,
    type: m.type,
    main: m.main,
    platforms: m.platforms.filter((p) => typeof p === "string"),
    downloadPaths: (m.downloadPaths ?? []).filter((p) => typeof p === "string" && p.startsWith("/")),
    ocrService:
      m.ocrService && typeof m.ocrService.basePath === "string" && m.ocrService.basePath.startsWith("/")
        ? { basePath: m.ocrService.basePath, model: String(m.ocrService.model ?? "") }
        : undefined,
    requires: { ollamaModels: (m.requires?.ollamaModels ?? []).filter((x) => typeof x === "string") },
    settings: settings.map((s) => ({ ...s, default: typeof s.default === "string" ? s.default : "" })),
    license: typeof m.license === "string" ? m.license : undefined,
    author: typeof m.author === "string" && m.author.trim() ? m.author.trim() : undefined,
    homepage: typeof m.homepage === "string" && /^https:\/\//.test(m.homepage) ? m.homepage : undefined,
  };
}
