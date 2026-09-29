/** PDF rendering, text extraction and scan detection with pdf.js (Apache-2.0) and @napi-rs/canvas (MIT). */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

let pdfjs: PdfJs | null = null;
async function lib(): Promise<PdfJs> {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/** pdf.js data folders; in a packaged app they are unpacked from app.asar. */
function assetDir(name: string): string {
  const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), name);
  const unpacked = dir.replace(`app.asar${"/"}`, `app.asar.unpacked${"/"}`);
  return `${existsSync(unpacked) ? unpacked : dir}/`;
}

export interface OpenPdf {
  doc: PdfDocument;
  close(): Promise<void>;
}

export async function openPdf(data: Uint8Array): Promise<OpenPdf> {
  const { getDocument } = await lib();
  const task = getDocument({
    data,
    cMapUrl: assetDir("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetDir("standard_fonts"),
    verbosity: 0,
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** 0-based page indexes: the requested 1-based pages that exist, else the first `maxPages`. */
export function pageIndexes(count: number, requested: number[] | null, maxPages: number): number[] {
  const selected = (requested ?? []).filter((p) => p >= 1 && p <= count).map((p) => p - 1);
  if (selected.length) return selected;
  return Array.from({ length: Math.min(count, maxPages) }, (_, i) => i);
}

export async function renderPage(doc: PdfDocument, index: number, dpi: number): Promise<Buffer> {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  // White background: transparent text PDFs read better for OCR on white
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "white" }).promise;
  page.cleanup();
  return canvas.toBuffer("image/png");
}

export async function pageText(doc: PdfDocument, index: number): Promise<string> {
  const page = await doc.getPage(index + 1);
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
  }
  return fixRadicals(text).trim();
}

/**
 * PDFs made by Chrome, Word and others often map kanji to look-alike Kangxi / CJK radical code
 * points (⾒ U+2F92 instead of 見). Only those characters are normalized; full-width letters stay as they are.
 */
export function fixRadicals(text: string): string {
  return text.replace(/[\u2e80-\u2fdf]/g, (ch) => ch.normalize("NFKC"));
}

type Matrix = [number, number, number, number, number, number];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Share of the page covered by images (0–1), from the page's drawing operators. */
export async function imageCoverage(page: PdfPage): Promise<number> {
  const { OPS } = await lib();
  const ops = await page.getOperatorList();
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.abs((x1 - x0) * (y1 - y0));
  if (!pageArea) return 0;
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let covered = 0;
  ops.fnArray.forEach((fn, i) => {
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i] as Matrix);
    else if (paint.has(fn)) {
      // Images are drawn into the unit square of the current transform
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map((p) => Math.min(Math.max(p[0], x0), x1));
      const ys = pts.map((p) => Math.min(Math.max(p[1], y0), y1));
      covered += (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    }
  });
  return Math.min(covered / pageArea, 1);
}

export async function isScanned(doc: PdfDocument, index: number, threshold: number): Promise<boolean> {
  return (await imageCoverage(await doc.getPage(index + 1))) >= threshold;
}
