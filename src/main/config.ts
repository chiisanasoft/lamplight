import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface FavoriteModel {
  /** Name shown in menus */
  label: string;
  /** LibreChat endpoint name, e.g. "Ollama", "openAI", "anthropic" */
  endpoint: string;
  model: string;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export type ServerMode = "embedded" | "external";

export interface ExtensionState {
  enabled: boolean;
  settings: Record<string, string>;
  port?: number;
  /** Signed by the Lamplight developers (recorded at install) */
  official?: boolean;
}

export interface Config {
  /** "embedded": Lamplight runs its own LibreChat server; "external": connect to serverUrl */
  serverMode: ServerMode;
  /** LibreChat server used in external mode */
  serverUrl: string;
  /** Port the embedded server reuses, so its login cookie and settings survive restarts */
  embeddedPort?: number;
  /** Per-extension state: enabled, settings, and the port kept across launches */
  extensions: Record<string, ExtensionState>;
  quickEntryShortcut: string;
  favorites: FavoriteModel[];
  /** Favorite preselected in quick entry; -1 = LibreChat's default model */
  defaultFavorite: number;
  notifyOnComplete: boolean;
  /** Keep running in the menu bar / tray when the main window is closed */
  keepRunningInTray: boolean;
  launchAtLogin: boolean;
  /** Check GitHub Releases for a newer Lamplight on start and download it in the background */
  checkForUpdates: boolean;
  mainWindowBounds?: WindowBounds;
}

export const DEFAULT_CONFIG: Config = {
  serverMode: "embedded",
  serverUrl: "http://localhost:3080",
  extensions: {},
  quickEntryShortcut: "Alt+Space",
  favorites: [],
  defaultFavorite: -1,
  notifyOnComplete: true,
  keepRunningInTray: true,
  launchAtLogin: false,
  checkForUpdates: true,
};

/** Normalizes user input to an origin-like base URL without a trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const url = new URL(s);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Merges stored data over defaults, dropping fields with the wrong type. */
export function sanitizeConfig(raw: unknown): Config {
  const c: Config = { ...DEFAULT_CONFIG, favorites: [] };
  if (!raw || typeof raw !== "object") return c;
  const r = raw as Record<string, unknown>;

  if (typeof r.serverUrl === "string") {
    try {
      c.serverUrl = normalizeServerUrl(r.serverUrl);
    } catch {
      /* keep default */
    }
  }
  if (r.serverMode === "embedded" || r.serverMode === "external") {
    c.serverMode = r.serverMode;
  } else if (typeof r.serverUrl === "string" && c.serverUrl !== DEFAULT_CONFIG.serverUrl) {
    // Settings from v0.1 (client only) that point at a server keep using it
    c.serverMode = "external";
  }
  const validPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 1024 && v < 65536;
  if (validPort(r.embeddedPort)) c.embeddedPort = r.embeddedPort;
  c.extensions = {};
  if (r.extensions && typeof r.extensions === "object") {
    for (const [id, raw] of Object.entries(r.extensions as Record<string, Partial<ExtensionState>>)) {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || !raw || typeof raw !== "object") continue;
      const settings = Object.fromEntries(
        Object.entries(raw.settings ?? {}).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>;
      c.extensions[id] = {
        enabled: raw.enabled === true,
        settings,
        ...(validPort(raw.port) ? { port: raw.port } : {}),
        ...(raw.official === true ? { official: true } : {}),
      };
    }
  }
  // v0.3 kept OCR settings at the top level; they now belong to the "ocr" extension
  if (!c.extensions.ocr && (typeof r.ocrFormatModel === "string" || typeof r.ocrTemplate === "string")) {
    const settings: Record<string, string> = {};
    if (typeof r.ocrFormatModel === "string" && r.ocrFormatModel.trim()) settings.formatLlm = r.ocrFormatModel.trim();
    if (typeof r.ocrTemplate === "string" && r.ocrTemplate.trim()) settings.template = r.ocrTemplate.trim();
    c.extensions.ocr = { enabled: false, settings };
  }
  if (typeof r.quickEntryShortcut === "string" && r.quickEntryShortcut.trim()) {
    c.quickEntryShortcut = r.quickEntryShortcut.trim();
  }
  if (Array.isArray(r.favorites)) {
    c.favorites = r.favorites.filter(
      (f): f is FavoriteModel =>
        !!f &&
        typeof f === "object" &&
        typeof (f as FavoriteModel).endpoint === "string" &&
        typeof (f as FavoriteModel).model === "string" &&
        !!(f as FavoriteModel).endpoint.trim() &&
        !!(f as FavoriteModel).model.trim(),
    ).map((f) => ({
      label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : f.model.trim(),
      endpoint: f.endpoint.trim(),
      model: f.model.trim(),
    }));
  }
  if (typeof r.defaultFavorite === "number" && Number.isInteger(r.defaultFavorite)) {
    c.defaultFavorite = r.defaultFavorite >= 0 && r.defaultFavorite < c.favorites.length ? r.defaultFavorite : -1;
  }
  for (const key of ["notifyOnComplete", "keepRunningInTray", "launchAtLogin", "checkForUpdates"] as const) {
    if (typeof r[key] === "boolean") c[key] = r[key] as boolean;
  }
  const b = r.mainWindowBounds as WindowBounds | undefined;
  if (b && typeof b.width === "number" && typeof b.height === "number") {
    c.mainWindowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  return c;
}

export class ConfigStore {
  private config: Config;

  constructor(private readonly path: string) {
    this.config = ConfigStore.read(path);
  }

  private static read(path: string): Config {
    try {
      return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return sanitizeConfig(undefined);
    }
  }

  get(): Config {
    return structuredClone(this.config);
  }

  update(patch: Partial<Config>): Config {
    this.config = sanitizeConfig({ ...this.config, ...patch });
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    renameSync(tmp, this.path);
    return this.get();
  }
}
