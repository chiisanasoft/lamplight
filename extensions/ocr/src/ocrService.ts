/**
 * Mistral OCR–compatible API, so LibreChat's own document upload ("テキストとしてアップロード")
 * can use local OCR. LibreChat's mistral_ocr strategy calls, against the configured baseURL:
 *
 *   POST   /v1/files             multipart upload (purpose=ocr)      -> { id }
 *   GET    /v1/files/:id/url     signed URL for the upload           -> { url }
 *   POST   /v1/ocr               { document: { document_url | image_url } } -> { pages: [{ index, markdown }] }
 *   DELETE /v1/files/:id
 *
 * Pages with a real text layer use it directly; scanned pages (or pages without text) are read with
 * the OCR model, and tables in its output become Markdown tables.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ocrText } from "./ocr";
import { isScanned, openPdf, pageIndexes, pageText, renderPage } from "./pdf";
import { convertHtmlTables } from "./tables";

interface StoredFile {
  name: string;
  mime: string;
  data: Buffer;
  createdAt: number;
}

export interface OcrServiceOptions {
  port: number;
  upstream: string;
  ocrModel: string;
  dpi: number;
  maxPages: number;
  ocrMaxTokens: number;
  scanCoverage: number;
  autoHeader: boolean;
  /** Bearer token LibreChat must send; empty disables the check */
  token: string;
}

const FILE_TTL_MS = 60 * 60 * 1000;

/** Minimal multipart/form-data parser for a single uploaded file. */
export function parseMultipartFile(body: Buffer, contentType: string): { name: string; mime: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.subarray(start + boundary.length + 2, next - 2); // skip CRLF after boundary and before next
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString("utf8");
      const filename = /filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i.exec(headers)?.[1];
      if (filename) {
        const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? "application/octet-stream";
        return { name: decodeURIComponent(filename), mime, data: Buffer.from(part.subarray(headerEnd + 4)) };
      }
    }
    start = next;
  }
  return null;
}

export function createOcrService(opts: OcrServiceOptions) {
  const files = new Map<string, StoredFile>();

  const prune = () => {
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const [id, f] of files) if (f.createdAt < cutoff) files.delete(id);
  };

  const authorized = (req: IncomingMessage) =>
    !opts.token || req.headers.authorization === `Bearer ${opts.token}`;

  const send = (res: ServerResponse, status: number, obj: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  async function documentBytes(doc: { type?: string; document_url?: string; image_url?: string }): Promise<{ mime: string; data: Buffer } | null> {
    const url = doc.document_url ?? doc.image_url ?? "";
    const own = new RegExp(`^http://127\\.0\\.0\\.1:${opts.port}/v1/files/([0-9a-f]{32})/content$`).exec(url);
    if (own) {
      const f = files.get(own[1]);
      return f ? { mime: f.mime, data: f.data } : null;
    }
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      return { mime: url.slice(5, comma).split(";")[0], data: Buffer.from(url.slice(comma + 1), "base64") };
    }
    return null; // remote URLs are not fetched: the service only reads what LibreChat uploaded
  }

  async function ocrImage(data: Buffer, mime: string): Promise<string> {
    const image = { type: "image_url" as const, image_url: { url: `data:${mime};base64,${data.toString("base64")}` } };
    const raw = await ocrText({ upstream: opts.upstream, model: opts.ocrModel, image, prompt: "Text Recognition:", maxTokens: opts.ocrMaxTokens });
    return convertHtmlTables(raw, opts.autoHeader).text;
  }

  async function ocrDocument(data: Buffer, mime: string): Promise<{ index: number; markdown: string }[]> {
    if (mime.startsWith("image/")) return [{ index: 0, markdown: await ocrImage(data, mime) }];
    const { doc, close } = await openPdf(new Uint8Array(data));
    try {
      const pages: { index: number; markdown: string }[] = [];
      for (const i of pageIndexes(doc.numPages, null, opts.maxPages)) {
        let text = await pageText(doc, i);
        if (opts.ocrModel && (!text || (await isScanned(doc, i, opts.scanCoverage)))) {
          text = await ocrImage(await renderPage(doc, i, opts.dpi), "image/png");
        }
        pages.push({ index: i, markdown: text });
      }
      return pages;
    } finally {
      await close();
    }
  }

  /** Handles the Mistral OCR routes; returns false for other paths. */
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer): Promise<boolean> {
    const fileRoute = /^\/v1\/files(?:\/([0-9a-f]{32}))?(\/url|\/content)?$/.exec(path);
    if (!fileRoute && path !== "/v1/ocr") return false;
    // The content URL is handed back to LibreChat, which passes it to /v1/ocr; everything else needs the token
    if (!(fileRoute?.[2] === "/content") && !authorized(req)) {
      send(res, 401, { detail: "Unauthorized" });
      return true;
    }
    prune();

    if (path === "/v1/files" && req.method === "POST") {
      const f = parseMultipartFile(body, req.headers["content-type"] ?? "");
      if (!f) return send(res, 400, { detail: "file is missing" }), true;
      const id = randomUUID().replace(/-/g, "");
      files.set(id, { ...f, createdAt: Date.now() });
      send(res, 200, { id, object: "file", bytes: f.data.length, filename: f.name, purpose: "ocr", created_at: Math.floor(Date.now() / 1000) });
      return true;
    }
    if (fileRoute?.[1]) {
      const id = fileRoute[1];
      const f = files.get(id);
      if (fileRoute[2] === "/url" && req.method === "GET") {
        if (!f) return send(res, 404, { detail: "not found" }), true;
        send(res, 200, { url: `http://127.0.0.1:${opts.port}/v1/files/${id}/content`, expires_at: Math.floor((f.createdAt + FILE_TTL_MS) / 1000) });
        return true;
      }
      if (fileRoute[2] === "/content" && req.method === "GET") {
        if (!f) return res.writeHead(404).end(), true;
        res.writeHead(200, { "Content-Type": f.mime });
        res.end(f.data);
        return true;
      }
      if (!fileRoute[2] && req.method === "DELETE") {
        files.delete(id);
        send(res, 200, { id, object: "file", deleted: true });
        return true;
      }
    }
    if (path === "/v1/ocr" && req.method === "POST") {
      const request = JSON.parse(body.toString("utf8") || "{}") as { model?: string; document?: { type?: string; document_url?: string; image_url?: string } };
      const doc = request.document ? await documentBytes(request.document) : null;
      if (!doc) return send(res, 400, { detail: "document not found" }), true;
      const pages = await ocrDocument(doc.data, doc.mime);
      send(res, 200, {
        pages: pages.map((p) => ({ ...p, images: [], dimensions: null })),
        model: request.model ?? opts.ocrModel,
        usage_info: { pages_processed: pages.length, doc_size_bytes: doc.data.length },
      });
      return true;
    }
    send(res, 404, { detail: "not found" });
    return true;
  };
}
