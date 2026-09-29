import type { BrowserWindowConstructorOptions, NativeImage } from "electron";
import { darwin } from "./darwin";
import { linux } from "./linux";

/**
 * Everything that differs per OS lives behind this interface.
 * A Windows port adds a `win32` implementation here.
 */
export interface Platform {
  /** Runs before app "ready" (command-line switches etc.) */
  prepare(): void;
  trayIcon(): NativeImage;
  /** Extra options for the frameless quick-entry panel */
  quickEntryWindowOptions(): Partial<BrowserWindowConstructorOptions>;
  setLaunchAtLogin(enabled: boolean): void;
  /** Hint shown when the global shortcut cannot be registered */
  shortcutFailureHint: string;
}

export function currentPlatform(): Platform {
  switch (process.platform) {
    case "darwin":
      return darwin;
    case "linux":
      return linux;
    default:
      throw new Error(`Lamplight does not support ${process.platform} yet`);
  }
}
