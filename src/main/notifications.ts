import { Notification, session } from "electron";
import { responseStreamId } from "./urls";

const DEDUPE_MS = 60_000;

/**
 * Notifies when a LibreChat response finishes while the window is in the background.
 * Completion is detected from the end of the response stream request, so LibreChat
 * itself needs no changes.
 */
export function watchResponses(opts: {
  partition: string;
  serverUrl: () => string;
  enabled: () => boolean;
  isWindowFocused: () => boolean;
  windowTitle: () => string;
  onClick: () => void;
}) {
  const recent = new Map<string, number>();

  session.fromPartition(opts.partition).webRequest.onCompleted(
    { urls: ["*://*/api/agents/chat/stream/*"] },
    (details) => {
      const id = responseStreamId(opts.serverUrl(), details.url);
      if (!id || details.statusCode !== 200 || !opts.enabled() || opts.isWindowFocused()) return;

      // Resumed streams reconnect with the same id; notify once per response
      const now = Date.now();
      for (const [key, at] of recent) if (now - at > DEDUPE_MS) recent.delete(key);
      if (recent.has(id)) return;
      recent.set(id, now);

      if (!Notification.isSupported()) return;
      const title = opts.windowTitle().replace(/\s*[|–-]\s*Lamplight\s*$/, "").trim();
      const n = new Notification({
        title: "応答が完了しました",
        body: title && title !== "Lamplight" ? title : "Lamplight",
        silent: false,
      });
      n.on("click", opts.onClick);
      n.show();
    },
  );
}
