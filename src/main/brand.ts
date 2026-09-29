/**
 * Lamplight shows its own name and logo in place of LibreChat's defaults.
 * Branding an operator configured on the server (APP_TITLE, CUSTOM_FOOTER) is left as is.
 */
export const APP_NAME = "Lamplight";

const DEFAULT_SERVER_TITLE = /LibreChat/g;

/** Window title for a page title set by LibreChat, e.g. "LibreChat" or "Trip plan | LibreChat". */
export function brandTitle(pageTitle: string): string {
  const title = pageTitle.replace(DEFAULT_SERVER_TITLE, APP_NAME).trim();
  return title || APP_NAME;
}

/** Stylesheet injected into LibreChat pages. */
export function brandCss(logoDataUrl: string): string {
  return [
    // Login / register pages render LibreChat's logo from assets/logo.svg
    `img[src$="assets/logo.svg"] { content: url("${logoDataUrl}"); }`,
    // Default footer ("LibreChat vX - …" linking to librechat.ai); a custom footer stays visible
    `div:has(> span > a[href="https://librechat.ai"]) { display: none !important; }`,
  ].join("\n");
}
