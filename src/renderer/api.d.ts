interface ExtResult { ok: boolean; error?: string; restartRequired?: boolean; name?: string; canceled?: boolean }

interface ExtensionManifestView {
  id: string;
  name: string;
  version: string;
  description: string;
  license?: string;
  author?: string;
  homepage?: string;
  requires?: { ollamaModels?: string[] };
  settings?: { key: string; label: string; type: "text" | "ollama-model"; default: string; description?: string }[];
}

interface ExtensionList {
  platform: string;
  mode: "embedded" | "external";
  catalog: { id: string; name: string; description: string; available: boolean }[];
  installed: { manifest: ExtensionManifestView; enabled: boolean; settings: Record<string, string>; running: boolean; official: boolean }[];
}

interface FavoriteModel { label: string; endpoint: string; model: string }

interface LamplightConfig {
  serverMode: "embedded" | "external";
  activeServerMode?: "embedded" | "external";
  serverUrl: string;
  quickEntryShortcut: string;
  favorites: FavoriteModel[];
  defaultFavorite: number;
  notifyOnComplete: boolean;
  keepRunningInTray: boolean;
  launchAtLogin: boolean;
  checkForUpdates: boolean;
}

interface Window {
  lamplight: {
    // quick entry
    state(): Promise<{ favorites: FavoriteModel[]; defaultFavorite: number; shortcut: string }>;
    submit(prompt: string, favoriteIndex: number): void;
    hide(): void;
    onOpened(cb: () => void): void;
    // settings
    get(): Promise<LamplightConfig>;
    save(patch: Partial<LamplightConfig>): Promise<{ ok: boolean; error?: string; config?: LamplightConfig; shortcutError?: string | null; restartRequired?: boolean }>;
    testServer(url: string): Promise<boolean>;
    ollamaModels(): Promise<string[]>;
    // offline / startup pages
    retry(): void;
    openSettings(): void;
    startupState(): Promise<unknown>;
    onStartupStep(cb: (step: unknown) => void): void;
    consent(): void;
    retryStartup(): void;
    relaunch(): void;
    openServerFile(which: "serverEnv" | "librechatYaml" | "dataDir"): Promise<string>;
    extList(): Promise<ExtensionList>;
    extInstallFile(): Promise<ExtResult>;
    extInstallCatalog(id: string): Promise<ExtResult>;
    extSetEnabled(id: string, enabled: boolean): Promise<ExtResult>;
    extSaveSettings(id: string, settings: Record<string, string>): Promise<ExtResult>;
    extUninstall(id: string): Promise<ExtResult>;
    extRestartServer(): void;
    onFocusSection(cb: (id: string) => void): void;
  };
}
