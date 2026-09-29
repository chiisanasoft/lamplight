/** HTML tables from OCR output -> Markdown tables and Excel worksheets. */
import type { Workbook, Worksheet } from "exceljs";
import { Parser } from "htmlparser2";
import { inferHeaders } from "./headers";

export class Cell {
  constructor(
    public text: string,
    public colspan = 1,
    public rowspan = 1,
    public header = false,
  ) {}
}

export class Table {
  rows: Cell[][] = [];

  /** Expands spans into a rectangular grid; merges are [r1, c1, r2, c2] (0-based). */
  grid(): { grid: string[][]; merges: [number, number, number, number][] } {
    const placed = new Map<string, string>();
    const merges: [number, number, number, number][] = [];
    let maxR = -1;
    let maxC = -1;
    this.rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row) {
        while (placed.has(`${r},${c}`)) c++;
        for (let dr = 0; dr < cell.rowspan; dr++) {
          for (let dc = 0; dc < cell.colspan; dc++) {
            placed.set(`${r + dr},${c + dc}`, dr === 0 && dc === 0 ? cell.text : "");
            maxR = Math.max(maxR, r + dr);
            maxC = Math.max(maxC, c + dc);
          }
        }
        if (cell.rowspan > 1 || cell.colspan > 1) merges.push([r, c, r + cell.rowspan - 1, c + cell.colspan - 1]);
        c += cell.colspan;
      }
    });
    if (maxR < 0) return { grid: [], merges: [] };
    const grid = Array.from({ length: maxR + 1 }, (_, r) =>
      Array.from({ length: maxC + 1 }, (_, c) => placed.get(`${r},${c}`) ?? ""),
    );
    return { grid, merges };
  }
}

const span = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, 100)) : 1;
};

export function parseTable(html: string): Table {
  const table = new Table();
  let cell: Cell | null = null;
  let buf: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "tr") table.rows.push([]);
        else if (name === "td" || name === "th") {
          if (!table.rows.length) table.rows.push([]);
          cell = new Cell("", span(attrs.colspan), span(attrs.rowspan), name === "th");
          buf = [];
        } else if (name === "br" && cell) buf.push("\n");
      },
      ontext(text) {
        if (cell) buf.push(text);
      },
      onclosetag(name) {
        if ((name === "td" || name === "th") && cell) {
          cell.text = buf.join("").replace(/[ \t]+/g, " ").trim();
          table.rows[table.rows.length - 1].push(cell);
          cell = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return table;
}

export function addInferredHeader(table: Table): boolean {
  const labels = inferHeaders(table.grid().grid);
  if (!labels) return false;
  // OCR models tag the first data row as <th>; it is data once a real header exists
  for (const row of table.rows) for (const c of row) c.header = false;
  table.rows.unshift(labels.map((l) => new Cell(l, 1, 1, true)));
  return true;
}

export function toMarkdown(table: Table): string {
  const { grid } = table.grid();
  if (!grid.length) return "";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>") || " ";
  const lines = [`| ${grid[0].map(esc).join(" | ")} |`, `|${"---|".repeat(grid[0].length)}`];
  for (const row of grid.slice(1)) lines.push(`| ${row.map(esc).join(" | ")} |`);
  return lines.join("\n");
}

const TABLE_RE = /<table\b[\s\S]*?<\/table>/gi;

/** Replaces each <table> in OCR output with a Markdown table. */
export function convertHtmlTables(text: string, autoHeader = true): { text: string; tables: Table[] } {
  const tables: Table[] = [];
  const out = text.replace(TABLE_RE, (html) => {
    const t = parseTable(html);
    if (!t.rows.length) return html;
    if (autoHeader) addInferredHeader(t);
    tables.push(t);
    return `\n\n${toMarkdown(t)}\n\n`;
  });
  return { text: out.trim(), tables };
}

// ---------------------------------------------------------------- Excel

export const THIN_BORDER = {
  top: { style: "thin" as const, color: { argb: "FF999999" } },
  left: { style: "thin" as const, color: { argb: "FF999999" } },
  bottom: { style: "thin" as const, color: { argb: "FF999999" } },
  right: { style: "thin" as const, color: { argb: "FF999999" } },
};

/** Keeps codes like 03-1234-5678 or 0120 as text; converts plain numbers. */
export function typed(value: string): string | number {
  if (/^-?[1-9]\d{0,14}$/.test(value) || /^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return w;
}

export function sheetTitle(name: string, existing: string[]): string {
  const base = name.replace(/[[\]:*?/\\]/g, "_").slice(0, 28) || "Sheet";
  let title = base;
  for (let n = 2; existing.includes(title); n++) title = `${base}_${n}`;
  return title;
}

/** One worksheet for a table; spans are kept as merged cells. */
export function addTableSheet(wb: Workbook, name: string, table: Table): Worksheet {
  const ws = wb.addWorksheet(sheetTitle(name, wb.worksheets.map((w) => w.name)));
  const { grid, merges } = table.grid();
  const headerRows = new Set(table.rows.map((row, r) => (row.length && row.every((c) => c.header) ? r : -1)));
  const widths = new Map<number, number>();
  grid.forEach((row, r) => {
    row.forEach((value, c) => {
      const cell = ws.getCell(r + 1, c + 1);
      cell.value = typed(value);
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: true };
      if (headerRows.has(r)) cell.font = { bold: true };
      const longest = Math.max(0, ...value.split("\n").map(displayWidth));
      widths.set(c, Math.max(widths.get(c) ?? 0, longest));
    });
  });
  for (const [r1, c1, r2, c2] of merges) ws.mergeCells(r1 + 1, c1 + 1, r2 + 1, c2 + 1);
  for (const [c, w] of widths) ws.getColumn(c + 1).width = Math.min(Math.max(w + 2, 6), 60);
  return ws;
}
