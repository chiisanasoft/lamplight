/** Extensions offered in Settings → 拡張機能 for download. Downloads are checked like files added by hand. */

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Download URL per "<platform>-<arch>"; a missing platform shows as "準備中" */
  downloads: Record<string, string>;
}

/**
 * Empty for now: extensions are added from a file. The list is where a future directory of
 * published extensions (by anyone) will appear.
 */
export const CATALOG: CatalogEntry[] = [];
