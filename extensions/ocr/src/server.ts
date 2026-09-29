/**
 * OCR proxy between LibreChat and Ollama (Node port of librechat-ocr-bridge).
 *
 * LibreChat sends PDFs as OpenAI `file` content parts, which Ollama rejects with
 * "400 invalid message format". This proxy rewrites them before forwarding:
 *
 * - OCR models (e.g. glm-ocr): each PDF page is rendered to an image and OCR'd on its own; the prompt
 *   is mapped to a supported task prompt. HTML tables become Markdown tables plus an Excel download.
 * - Vision models: PDF pages become `image_url` parts.
 * - Other models: the PDF's text is extracted; scanned pages are OCR'd with the OCR model first.
 * - The virtual model "ocr-format" runs a fixed workflow: OCR every page → merge into one table →
 *   reshape to a column template with the formatting LLM → rule checks → one table + Excel.
 *
 * Everything else is passed through to Ollama unchanged (including streaming).
 * Lamplight extension "ocr": runs as a child process on Electron's Node.js and receives its config in
 * the LAMPLIGHT_EXT_CONFIG environment variable (port, Ollama URL, data folder, settings).
 */
import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import * as fmt from "./formatter";
import { newUsage, ocrPrompt, ocrText, requestedPages, type ImagePart, type Usage } from "./ocr";
import { createOcrService } from "./ocrService";
import { isScanned, openPdf, pageIndexes, pageText, renderPage } from "./pdf";
import { addTableSheet, convertHtmlTables, type Table } from "./tables";

export interface OcrConfig {
  port: number;
  upstream: string;
  exportDir: string;
  /** Model names treated as OCR models (without tag), e.g. ["glm-ocr"] */
  ocrModels: string[];
  /** Model used to OCR scans for non-vision models and in ocr-format ("" disables it) */
  ocrModel: string;
  dpi: number;
  maxPages: number;
  ocrMaxTokens: number;
  scanCoverage: number;
  exportTtlHours: number;
  autoHeader: boolean;
  formatModelName: string;
  /** Model that reshapes rows in ocr-format; "" hides the workflow */
  formatLlm: string;
  formatTemplate: string[];
  formatBatchRows: number;
  /** Bearer token for the Mistral OCR–compatible API used by LibreChat */
  serviceToken: string;
}

type Part = { type: string; text?: string; image_url?: { url: string }; file?: { filename?: string; file_data?: string } };
type Message = { role: string; content: string | Part[] };
type ChatBody = { model: string; messages: Message[]; stream?: boolean; stream_options?: { include_usage?: boolean } };

const log = (...a: unknown[]) => console.log(`[ocr-proxy ${new Date().toISOString()}]`, ...a);

export function createOcrServer(cfg: OcrConfig) {
  const visionCache = new Map<string, boolean>();
  const baseModel = (m: string) => m.split(":")[0];
  const isOcrModel = (m: string) => cfg.ocrModels.includes(baseModel(m));

  async function isVisionModel(model: string): Promise<boolean> {
    if (!visionCache.has(model)) {
      try {
        const r = await fetch(`${cfg.upstream}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
        const d = (await r.json()) as { capabilities?: string[] };
        visionCache.set(model, (d.capabilities ?? []).includes("vision"));
      } catch {
        return false;
      }
    }
    return visionCache.get(model)!;
  }

  // ------------------------------------------------------------ attachments

  const dataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString("base64")}`;
  const imagePart = (url: string): ImagePart => ({ type: "image_url", image_url: { url } });

  function filePayload(part: Part): { filename: string; mime: string; data: Buffer } | null {
    const url = part.type === "file" ? part.file?.file_data ?? "" : "";
    if (!url.startsWith("data:")) return null;
    const comma = url.indexOf(",");
    const mime = url.slice(5, comma).split(";")[0];
    return { filename: part.file?.filename || "document", mime, data: Buffer.from(url.slice(comma + 1), "base64") };
  }

  const messageText = (content: Part[]) => content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");

  async function pdfImages(pdf: Buffer, pages: number[] | null): Promise<ImagePart[]> {
    const { doc, close } = await openPdf(new Uint8Array(pdf));
    try {
      const out: ImagePart[] = [];
      for (const i of pageIndexes(doc.numPages, pages, cfg.maxPages)) {
        out.push(imagePart(dataUrl("image/png", await renderPage(doc, i, cfg.dpi))));
      }
      return out;
    } finally {
      await close();
    }
  }

  async function pdfToText(pdf: Buffer, filename: string, pages: number[] | null, prompt: string): Promise<string> {
    const { doc, close } = await openPdf(new Uint8Array(pdf));
    try {
      const parts: string[] = [];
      for (const i of pageIndexes(doc.numPages, pages, cfg.maxPages)) {
        let text = await pageText(doc, i);
        if (cfg.ocrModel && (!text || (await isScanned(doc, i, cfg.scanCoverage)))) {
          log(`OCR fallback page=${i + 1} model=${cfg.ocrModel} prompt=${prompt}`);
          const image = imagePart(dataUrl("image/png", await renderPage(doc, i, cfg.dpi)));
          text = convertHtmlTables(await ocrText({ upstream: cfg.upstream, model: cfg.ocrModel, image, prompt, maxTokens: cfg.ocrMaxTokens }), cfg.autoHeader).text;
        }
        parts.push(`--- Page ${i + 1} ---\n${text.trim()}`);
      }
      return `File: "${filename}"\n\n${parts.join("\n\n")}`;
    } finally {
      await close();
    }
  }

  /** Replaces `file` parts in all messages with parts Ollama understands. */
  async function rewriteFileParts(body: ChatBody) {
    let vision: boolean | null = null;
    for (const msg of body.messages ?? []) {
      if (!Array.isArray(msg.content)) continue;
      const content: Part[] = [];
      for (const part of msg.content) {
        const f = filePayload(part);
        if (!f) {
          content.push(part);
          continue;
        }
        if (f.mime === "application/pdf") {
          vision ??= await isVisionModel(body.model);
          const request = messageText(msg.content);
          const pages = requestedPages(request);
          if (vision) content.push(...(await pdfImages(f.data, pages)));
          else content.push({ type: "text", text: await pdfToText(f.data, f.filename, pages, ocrPrompt(request)) });
        } else if (f.mime.startsWith("image/")) {
          content.push(imagePart(dataUrl(f.mime, f.data)));
        } else {
          content.push({ type: "text", text: `File: "${f.filename}"\n\n${f.data.toString("utf8")}` });
        }
      }
      msg.content = content;
    }
  }

  /** Images/pages of the last user turn, the task prompt and a source name for exports. */
  async function buildOcrJobs(body: ChatBody): Promise<{ images: ImagePart[]; prompt: string; source: string; text: string } | null> {
    const users = (body.messages ?? []).filter((m) => m.role === "user");
    const content = users[users.length - 1]?.content;
    if (!Array.isArray(content)) return null;
    const text = messageText(content);
    const pages = requestedPages(text);
    const images: ImagePart[] = [];
    let source = "ocr";
    for (const part of content) {
      const f = filePayload(part);
      if (f) source = basename(f.filename, extname(f.filename)) || source;
      if (f?.mime === "application/pdf") images.push(...(await pdfImages(f.data, pages)));
      else if (f?.mime.startsWith("image/")) images.push(imagePart(dataUrl(f.mime, f.data)));
      else if (part.type === "image_url" && part.image_url) images.push(imagePart(part.image_url.url));
    }
    return images.length ? { images, prompt: ocrPrompt(text), source, text } : null;
  }

  // ------------------------------------------------------------ exports

  function exportPath(source: string): { path: string; url: string } {
    mkdirSync(cfg.exportDir, { recursive: true });
    const cutoff = Date.now() - cfg.exportTtlHours * 3600_000;
    for (const token of readdirSync(cfg.exportDir)) {
      const dir = join(cfg.exportDir, token);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    const token = randomUUID().replace(/-/g, "");
    const name = `${source.replace(/[\\/:*?"<>|]/g, "_")}.xlsx`;
    mkdirSync(join(cfg.exportDir, token));
    return { path: join(cfg.exportDir, token, name), url: `http://127.0.0.1:${cfg.port}/exports/${token}/${encodeURIComponent(name)}` };
  }

  // ------------------------------------------------------------ responses

  function chunk(id: string, model: string, delta: object, finish: string | null = null) {
    const obj = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
    return `data: ${JSON.stringify(obj)}\n\n`;
  }

  /** Sends generated text pieces as an OpenAI chat completion (streamed or not). */
  async function respond(res: ServerResponse, body: ChatBody, pieces: AsyncGenerator<string>, usage: Usage) {
    const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
    if (!body.stream) {
      let content = "";
      for await (const t of pieces) content += t;
      sendJson(res, 200, {
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage,
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(chunk(id, body.model, { role: "assistant", content: "" }));
    for await (const t of pieces) res.write(chunk(id, body.model, { content: t }));
    res.write(chunk(id, body.model, {}, "stop"));
    if (body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [], usage })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  }

  async function* runOcr(body: ChatBody, images: ImagePart[], prompt: string, source: string, usage: Usage) {
    const multi = images.length > 1;
    const sheets: [string, Table][] = [];
    for (const [i, image] of images.entries()) {
      const raw = await ocrText({ upstream: cfg.upstream, model: body.model, image, prompt, maxTokens: cfg.ocrMaxTokens, usage });
      const { text, tables } = convertHtmlTables(raw, cfg.autoHeader);
      tables.forEach((t, n) => sheets.push([`Page${i + 1}${tables.length > 1 ? `_${n + 1}` : ""}`, t]));
      yield `${i ? "\n\n" : ""}${multi ? `## Page ${i + 1}\n\n` : ""}${text}`;
    }
    if (!sheets.length) return;
    try {
      const { path, url } = exportPath(source);
      const wb = new ExcelJS.Workbook();
      for (const [name, t] of sheets) addTableSheet(wb, name, t);
      await wb.xlsx.writeFile(path);
      yield `\n\n---\n\n📥 [Excelでダウンロード (${sheets.length}表)](${url})`;
    } catch (err) {
      log("xlsx export failed", err);
      yield "\n\n---\n\n(Excelファイルの作成に失敗しました)";
    }
  }

  async function* runFormat(images: ImagePart[], requestText: string, source: string, usage: Usage) {
    const template = fmt.parseTemplate(requestText, cfg.formatTemplate);
    yield `**OCR→整形**: ${images.length}ページを読み取り、\`${cfg.formatLlm}\` で「${template.join("・")}」の表に整形します。\n\n`;
    const pages: Table[][] = [];
    const originals: [string, Table][] = [];
    for (const [i, image] of images.entries()) {
      const raw = await ocrText({ upstream: cfg.upstream, model: cfg.ocrModel, image, prompt: "Table Recognition:", maxTokens: cfg.ocrMaxTokens, usage });
      const { tables } = convertHtmlTables(raw, cfg.autoHeader);
      pages.push(tables);
      tables.forEach((t, n) => originals.push([`P${i + 1}${tables.length > 1 ? `_${n + 1}` : ""}`, t]));
      const rows = tables.reduce((s, t) => s + Math.max(t.rows.length - 1, 0), 0);
      yield `- ${i + 1}ページ目を読み取りました（表 ${tables.length} 個・約 ${rows} 行）\n`;
    }
    const { columns, rows } = fmt.mergePages(pages);
    if (!rows.length) {
      yield "\n表を読み取れませんでした。ページの向きや解像度を確認してください。";
      return;
    }
    const shaped = new Map<number, fmt.ShapedRow>();
    const indexed = rows.map((r, i) => [i, r] as [number, fmt.SourceRow]);
    const batches: [number, fmt.SourceRow][][] = [];
    for (let k = 0; k < indexed.length; k += cfg.formatBatchRows) batches.push(indexed.slice(k, k + cfg.formatBatchRows));
    for (const [b, batch] of batches.entries()) {
      try {
        for (const [k, v] of await fmt.reshapeBatch({ upstream: cfg.upstream, model: cfg.formatLlm, template, sourceColumns: columns, batch })) shaped.set(k, v);
      } catch (err) {
        log(`format batch ${b + 1} failed`, err);
      }
      yield `- 整形 ${b + 1}/${batches.length}（${batch.length} 行）が終わりました\n`;
    }
    const result = fmt.finalize(template, rows, shaped, columns);
    const summary = (Object.keys(fmt.MARKS) as fmt.IssueKind[])
      .map((k) => [k, result.issues.filter((i) => i.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k} ${n}件`)
      .join("・") || "なし";
    yield `\n### 整形結果（${result.rows.length} 行）\n\n${fmt.toMarkdown(result)}\n\n✎ = LLMが補正した値、⚠ = 要確認（${summary}）\n\n#### 確認が必要な箇所\n\n${fmt.issuesMarkdown(result)}`;
    try {
      const { path, url } = exportPath(`${source}_整形済み`);
      await fmt.writeWorkbook(path, result, originals);
      yield `\n\n---\n\n📥 [Excelでダウンロード（整形済み・確認リスト・OCR原本）](${url})`;
    } catch (err) {
      log("xlsx export failed", err);
      yield "\n\n---\n\n(Excelファイルの作成に失敗しました)";
    }
  }

  // ------------------------------------------------------------ HTTP

  const HOP = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding", "keep-alive"]);

  function sendJson(res: ServerResponse, status: number, obj: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function forwardHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") out[k] = v;
    return out;
  }

  async function passthrough(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const r = await fetch(`${cfg.upstream}${req.url}`, {
      method: req.method,
      headers: forwardHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
    });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "content-encoding") headers[k] = v;
    });
    res.writeHead(r.status, headers);
    if (r.body) Readable.fromWeb(r.body as never).pipe(res);
    else res.end();
  }

  async function withVirtualModel(req: IncomingMessage, res: ServerResponse, path: "/v1/models" | "/api/tags") {
    const r = await fetch(`${cfg.upstream}${path}`, { headers: forwardHeaders(req) });
    const data = (await r.json()) as { data?: object[]; models?: object[] };
    if (cfg.formatLlm) {
      const name = cfg.formatModelName;
      if (path === "/v1/models") (data.data ??= []).push({ id: name, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "lamplight" });
      else (data.models ??= []).push({ name, model: name, modified_at: new Date().toISOString(), size: 0, digest: "", details: { format: "workflow", family: "lamplight", families: ["lamplight"], parameter_size: "", quantization_level: "" } });
    }
    sendJson(res, r.status, data);
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse, raw: Buffer) {
    let body: ChatBody;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return passthrough(req, res, raw);
    }
    const hasFiles = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file"));

    if (body.model === cfg.formatModelName) {
      if (!cfg.formatLlm) return sendJson(res, 400, { error: { message: "OCR→整形に使うモデルが設定されていません", type: "invalid_request_error" } });
      const jobs = await buildOcrJobs(body);
      if (jobs) {
        log(`FORMAT pages=${jobs.images.length} llm=${cfg.formatLlm}`);
        const usage = newUsage();
        return respond(res, body, runFormat(jobs.images, jobs.text, jobs.source, usage), usage);
      }
      // Follow-up turns (and title generation) are answered by the formatting LLM
      body.model = cfg.formatLlm;
    }

    if (isOcrModel(body.model)) {
      const jobs = await buildOcrJobs(body);
      if (jobs) {
        log(`OCR model=${body.model} pages=${jobs.images.length} prompt=${jobs.prompt}`);
        const usage = newUsage();
        return respond(res, body, runOcr(body, jobs.images, jobs.prompt, jobs.source, usage), usage);
      }
    }

    if (hasFiles) {
      await rewriteFileParts(body);
      log(`rewrote file parts for model=${body.model}`);
    }
    return passthrough(req, res, Buffer.from(JSON.stringify(body)));
  }

  function download(res: ServerResponse, token: string, name: string) {
    const file = decodeURIComponent(name);
    if (!/^[0-9a-f]{32}$/.test(token) || file.includes("/") || file.startsWith(".")) {
      res.writeHead(404).end();
      return;
    }
    const path = join(cfg.exportDir, token, file);
    try {
      statSync(path);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("このファイルは期限切れか存在しません");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
    });
    createReadStream(path).pipe(res);
  }

  const ocrService = createOcrService({
    port: cfg.port,
    upstream: cfg.upstream,
    ocrModel: cfg.ocrModel,
    dpi: cfg.dpi,
    maxPages: cfg.maxPages,
    ocrMaxTokens: cfg.ocrMaxTokens,
    scanCoverage: cfg.scanCoverage,
    autoHeader: cfg.autoHeader,
    token: cfg.serviceToken,
  });

  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/healthz") return sendJson(res, 200, { ok: true });
      if (await ocrService(req, res, path, body)) return;
      const m = /^\/exports\/([^/]+)\/([^/]+)$/.exec(path);
      if (m && req.method === "GET") return download(res, m[1], m[2]);
      if (path === "/v1/chat/completions" && req.method === "POST") return await chatCompletions(req, res, body);
      if ((path === "/v1/models" || path === "/api/tags") && req.method === "GET") return await withVirtualModel(req, res, path);
      return await passthrough(req, res, body);
    } catch (err) {
      log("request failed", req.method, path, err);
      if (!res.headersSent) sendJson(res, 502, { error: { message: `OCR proxy: ${err instanceof Error ? err.message : err}` } });
      else res.end();
    }
  });
}

/** Config Lamplight passes to an extension process (LAMPLIGHT_EXT_CONFIG). */
interface ExtensionConfig {
  port: number;
  upstream: string;
  dataDir: string;
  settings: Record<string, string>;
  /** Per-launch token shared with LibreChat for the OCR service */
  token?: string;
}

export function ocrConfigFrom(ext: ExtensionConfig): OcrConfig {
  const template = (ext.settings.template ?? "").split(/[,、]/).map((s) => s.trim()).filter(Boolean);
  return {
    port: ext.port,
    upstream: ext.upstream,
    exportDir: join(ext.dataDir, "exports"),
    ocrModels: ["glm-ocr"],
    ocrModel: "glm-ocr:latest",
    dpi: 200,
    maxPages: 20,
    ocrMaxTokens: 8192,
    scanCoverage: 0.5,
    exportTtlHours: 72,
    autoHeader: true,
    formatModelName: "ocr-format",
    formatLlm: (ext.settings.formatLlm ?? "").trim(),
    formatTemplate: template.length ? template : ["日付", "姓", "名", "郵便番号", "住所", "電話番号", "備考"],
    formatBatchRows: 15,
    serviceToken: ext.token ?? "",
  };
}

// Entry point when Lamplight starts the extension
if (process.env.LAMPLIGHT_EXT_CONFIG) {
  const cfg = ocrConfigFrom(JSON.parse(process.env.LAMPLIGHT_EXT_CONFIG) as ExtensionConfig);
  const server = createOcrServer(cfg);
  server.listen(cfg.port, "127.0.0.1", () => {
    log(`listening on 127.0.0.1:${cfg.port} upstream=${cfg.upstream} formatLlm=${cfg.formatLlm || "(off)"}`);
    process.send?.({ ready: true });
  });
}
