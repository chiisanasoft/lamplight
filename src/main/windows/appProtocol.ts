import { net, protocol, type Session } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * lamplight://app/ serves Lamplight's own pages (src/renderer). LibreChat's settings dialog embeds
 * lamplight://app/settings.html as its "デスクトップ" / "拡張機能" tabs; a file:// page could not be
 * framed by the http:// LibreChat page, and the scheme gives those frames an origin the preload and
 * the IPC handlers can recognize.
 */
export const APP_SCHEME = "lamplight";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

const RENDERER = join(__dirname, "..", "..", "renderer");

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function serveAppPages(ses: Session) {
  if (ses.protocol.isProtocolHandled(APP_SCHEME)) return;
  ses.protocol.handle(APP_SCHEME, (req) => {
    const url = new URL(req.url);
    if (url.host !== "app") return new Response(null, { status: 404 });
    const path = normalize(join(RENDERER, decodeURIComponent(url.pathname)));
    if (!path.startsWith(RENDERER + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

/** Frames allowed to use the app's IPC: its own pages, never LibreChat or content inside it. */
export function isAppFrame(url: string | undefined): boolean {
  return !!url && (url.startsWith(`${APP_ORIGIN}/`) || url.startsWith("file://"));
}
