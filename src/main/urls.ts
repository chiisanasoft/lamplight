import type { FavoriteModel } from "./config";

export interface NewChatOptions {
  prompt?: string;
  favorite?: FavoriteModel;
  /** Send the prompt immediately instead of only filling the input */
  submit?: boolean;
}

/**
 * LibreChat reads these query parameters on /c/new (client/src/hooks/Input/useQueryParams.ts):
 * endpoint, model, prompt and submit=true.
 */
export function buildNewChatUrl(serverUrl: string, opts: NewChatOptions = {}): string {
  const url = new URL(`${serverUrl}/c/new`);
  if (opts.favorite) {
    url.searchParams.set("endpoint", opts.favorite.endpoint);
    url.searchParams.set("model", opts.favorite.model);
  }
  const prompt = opts.prompt?.trim();
  if (prompt) {
    url.searchParams.set("prompt", prompt);
    if (opts.submit !== false) url.searchParams.set("submit", "true");
  }
  return url.toString();
}

/** True when `target` belongs to the LibreChat server (same origin). */
export function isServerUrl(serverUrl: string, target: string): boolean {
  try {
    return new URL(target).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** Matches LibreChat's resumable response stream: GET /api/agents/chat/stream/{streamId} */
const STREAM_PATH = /\/api\/agents\/chat\/stream\/([^/?#]+)/;

export function responseStreamId(serverUrl: string, target: string): string | null {
  if (!isServerUrl(serverUrl, target)) return null;
  const m = STREAM_PATH.exec(new URL(target).pathname);
  return m ? decodeURIComponent(m[1]) : null;
}
