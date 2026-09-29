/**
 * OCR -> one cleaned table: merge pages, reshape to a column template with an LLM,
 * normalize values by rule, and flag every cell the reader should double-check.
 *
 * Date columns are handled by rule (a small LLM splits "12/5K12/8T" inconsistently): the first
 * date goes to the template's date column, later dates and code letters go to the notes column.
 * The LLM reshapes the remaining columns and is only trusted to move, split and lightly correct
 * values. Its output is checked against the source row: values that do not occur in the source
 * are marked as corrections (with the original kept), letters/digits that disappeared are reported
 * as possible omissions, and format rules flag invalid dates, postal codes and phone numbers.
 */
import ExcelJS from "exceljs";
import { addTableSheet, displayWidth, THIN_BORDER, typed, type Table } from "./tables";

export const NOTES_COLUMN = "備考";

const SYSTEM_PROMPT = `あなたはOCRで読み取った表を、指定された列の表に整形する担当です。次のルールを必ず守ってください。
- 入力の各行につき、必ず1行を出力する。src には入力行の番号を入れる。
- 値は入力行の文字列から取る。入力にない情報を推測して作らない。該当する値がなければ空文字にする。
- 直してよいのは、形の似た文字の誤認識など明らかなOCRの誤りだけ。
- 1つのセルに複数の値（例: 日付が2つ）が入っていれば分割する。出力の列に入らない値は「備考」に入れる。
- 日付に付いた記号やアルファベット（例: 12/5K の K）、チェック記号、メモなどは捨てずに「備考」に入れる。
- 氏名が1つのセルにあり、出力に「姓」「名」の列があれば分割する。
- 郵便番号・電話番号・住所は、入力の見出し推定に関係なく、値の内容から正しい列に入れる。`;

// ---------------------------------------------------------------- template

/** Column template from the chat ("列: 日付, 氏名, 住所"), else the configured default. */
export function parseTemplate(text: string, fallback: string[]): string[] {
  const m = /(?:列|項目|columns?)\s*[:：]\s*([^\n]+)/i.exec(text);
  if (m) {
    const cols = m[1].split(/[,、，/／]/).map((c) => c.trim()).filter(Boolean);
    if (cols.length) return cols;
  }
  return [...fallback];
}

export type Kind = "date" | "postal" | "phone" | null;

export function columnKind(name: string): Kind {
  if (/日付|年月日|日時|date/i.test(name)) return "date";
  if (/郵便|〒|zip|postal/i.test(name)) return "postal";
  if (/電話|tel|phone|携帯/i.test(name)) return "phone";
  return null;
}

// ---------------------------------------------------------------- merging

export class SourceRow {
  constructor(public page: number, public cells: Record<string, string>) {}
  text(): string {
    return Object.values(this.cells).filter(Boolean).join(" ");
  }
}

/** Joins the tables of all pages into one list of rows keyed by (inferred) header. */
export function mergePages(pages: Table[][]): { columns: string[]; rows: SourceRow[] } {
  const columns: string[] = [];
  const rows: SourceRow[] = [];
  pages.forEach((pageTables, p) => {
    for (const t of pageTables) {
      const { grid } = t.grid();
      if (!grid.length) continue;
      const hasHeader = t.rows.length > 0 && t.rows[0].every((c) => c.header);
      const header = (hasHeader ? grid[0] : grid[0].map((_, i) => `列${i + 1}`)).map((h, i) => h || `列${i + 1}`);
      for (const h of header) if (!columns.includes(h)) columns.push(h);
      for (const values of hasHeader ? grid.slice(1) : grid) {
        // Blank rows and header rows repeated on later pages
        if (!values.some((v) => v.trim()) || values.join("\u0000") === header.join("\u0000")) continue;
        rows.push(new SourceRow(p + 1, Object.fromEntries(header.map((h, i) => [h, values[i] ?? ""]))));
      }
    }
  });
  return { columns, rows };
}

// ---------------------------------------------------------------- dates by rule

const DATE_TOKEN = /(\d{1,2})\s*[/・.．]\s*(\d{1,2})(?!\d)\s*([A-Za-z]?)/g;

const isDateSource = (header: string) => columnKind(header) === "date";

/** First date of the row's date columns, plus notes for suffixes, later dates and leftovers. */
export function splitDates(row: SourceRow): [string, string[]] {
  let first = "";
  const notes: string[] = [];
  for (const [header, value] of Object.entries(row.cells)) {
    if (!isDateSource(header) || !value.trim()) continue;
    const v = value.normalize("NFKC");
    for (const m of v.matchAll(DATE_TOKEN)) {
      const date = `${Number(m[1])}/${Number(m[2])}`;
      const code = m[3];
      if (!first) {
        first = date;
        if (code) notes.push(code);
      } else {
        notes.push(date + code);
      }
    }
    const leftover = v.replace(DATE_TOKEN, " ").replace(/^[\s・,、]+|[\s・,、]+$/g, "");
    if (leftover) notes.push(leftover);
  }
  return [first, notes];
}

// ---------------------------------------------------------------- LLM reshaping

export function rowSchema(template: string[]) {
  const keys = [...template, ...(template.includes(NOTES_COLUMN) ? [] : [NOTES_COLUMN])];
  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: { src: { type: "integer" }, ...Object.fromEntries(keys.map((k) => [k, { type: "string" }])) },
          required: ["src", ...keys],
        },
      },
    },
    required: ["rows"],
  };
}

export const ruleDateColumns = (template: string[], sourceColumns: string[]) =>
  template.some((c) => columnKind(c) === "date") && sourceColumns.some(isDateSource);

export type ShapedRow = Record<string, string | number>;

export async function reshapeBatch(opts: {
  upstream: string;
  model: string;
  template: string[];
  sourceColumns: string[];
  batch: [number, SourceRow][];
}): Promise<Map<number, ShapedRow>> {
  let { template, sourceColumns } = opts;
  if (ruleDateColumns(template, sourceColumns)) {
    // Dates are filled by rule in finalize(); keep them away from the LLM
    template = template.filter((c) => columnKind(c) !== "date");
    sourceColumns = sourceColumns.filter((c) => !isDateSource(c));
  }
  const lines = opts.batch.map(([i, row]) => `${i}: ${JSON.stringify(sourceColumns.map((c) => row.cells[c] ?? ""))}`);
  const user = `出力する列: ${template.join(", ")}\n入力の列（見出しは推定）: ${JSON.stringify(sourceColumns)}\n入力行:\n${lines.join("\n")}`;
  const res = await fetch(`${opts.upstream}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      stream: false,
      think: false,
      format: rowSchema(template),
      options: { temperature: 0 }, // context size comes from the model's num_ctx
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`format LLM HTTP ${res.status}`);
  const data = (await res.json()) as { message: { content: string } };
  const out = JSON.parse(data.message.content) as { rows?: ShapedRow[] };
  const wanted = new Set(opts.batch.map(([i]) => i));
  const shaped = new Map<number, ShapedRow>();
  for (const row of out.rows ?? []) if (wanted.has(Number(row.src))) shaped.set(Number(row.src), row);
  return shaped;
}

// ---------------------------------------------------------------- rules & checks

export function canon(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s・/.\-ー－()（）,、]/g, "");
}

export function normalize(value: string, kind: Kind): string {
  let v = value.normalize("NFKC").trim();
  if (kind === "date") {
    const m = /^(\d{1,4})\s*[/・.年-]\s*(\d{1,2})(?:\s*[/・.月-]\s*(\d{1,2}))?\s*日?$/.exec(v);
    if (m) v = [m[1], m[2], m[3]].filter(Boolean).join("/");
  } else if (kind === "postal") {
    const digits = v.replace(/\D/g, "");
    if (digits.length === 7) v = `${digits.slice(0, 3)}-${digits.slice(3)}`;
  } else if (kind === "phone") {
    v = v.replace(/\s+/g, "");
  }
  return v;
}

export function invalid(value: string, kind: Kind): string | null {
  if (!value || !kind) return null;
  if (kind === "date") {
    const parts = /^\d{1,4}(\/\d{1,2}){1,2}$/.test(value) ? value.split("/").map(Number) : [];
    const [month, day] = parts.length >= 2 ? parts.slice(-2) : [0, 0];
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return "日付の形式ではありません";
  } else if (kind === "postal" && !/^\d{3}-\d{4}$/.test(value)) {
    return "郵便番号の形式ではありません";
  } else if (kind === "phone" && !/^(?:0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10})$/.test(value)) {
    return "電話番号の形式ではありません";
  }
  return null;
}

export type IssueKind = "補正" | "要確認" | "欠落の可能性" | "未整形";

export interface Issue {
  row: number; // 1-based output row
  column: string;
  kind: IssueKind;
  detail: string;
}

export interface Result {
  columns: string[];
  rows: string[][];
  issues: Issue[];
}

const cellIssues = (r: Result) => new Map(r.issues.map((i) => [`${i.row}\u0000${i.column}`, i]));

const countAsciiAlnum = (s: string) => {
  const m = new Map<string, number>();
  for (const ch of canon(s)) if (/^[a-z0-9]$/.test(ch)) m.set(ch, (m.get(ch) ?? 0) + 1);
  return m;
};

export function finalize(template: string[], source: SourceRow[], shaped: Map<number, ShapedRow>, sourceColumns: string[] = []): Result {
  const columns = [...template];
  const dateCol = template.find((c) => columnKind(c) === "date");
  if (dateCol && ruleDateColumns(template, sourceColumns)) {
    source.forEach((src, i) => {
      const out = shaped.get(i);
      if (!out) return;
      const [first, extra] = splitDates(src);
      out[dateCol] = first;
      out[NOTES_COLUMN] = [...extra, String(out[NOTES_COLUMN] ?? "")].filter(Boolean).join(", ");
    });
  }
  if (!template.includes(NOTES_COLUMN) && source.some((_, i) => shaped.get(i)?.[NOTES_COLUMN])) columns.push(NOTES_COLUMN);
  const kinds = new Map(columns.map((c) => [c, columnKind(c)]));
  const result: Result = { columns, rows: [], issues: [] };

  source.forEach((src, i) => {
    const n = i + 1;
    let out = shaped.get(i);
    if (!out) {
      out = Object.fromEntries(columns.map((c) => [c, src.cells[c] ?? ""]));
      result.issues.push({ row: n, column: columns[0], kind: "未整形", detail: "LLMの出力がなかったため、元の列をそのまま使いました" });
    }
    const srcText = src.text();
    const srcCanon = canon(srcText);
    const values = columns.map((c) => {
      const v = normalize(String(out[c] ?? ""), kinds.get(c) ?? null);
      if (v && canon(v) && !srcCanon.includes(canon(v))) {
        result.issues.push({ row: n, column: c, kind: "補正", detail: `元の行: ${srcText}` });
      }
      const problem = invalid(v, kinds.get(c) ?? null);
      if (problem) result.issues.push({ row: n, column: c, kind: "要確認", detail: problem });
      return v;
    });
    const before = countAsciiAlnum(srcText);
    const after = countAsciiAlnum(values.join(" "));
    const missing: string[] = [];
    for (const [ch, count] of before) for (let k = after.get(ch) ?? 0; k < count; k++) missing.push(ch);
    if (missing.length) {
      result.issues.push({
        row: n,
        column: columns[columns.length - 1],
        kind: "欠落の可能性",
        detail: `元の行にあった「${missing.sort().join("")}」が見当たりません（元の行: ${srcText}）`,
      });
    }
    result.rows.push(values);
  });
  return result;
}

// ---------------------------------------------------------------- output

export const MARKS: Record<IssueKind, string> = { 補正: "✎", 要確認: "⚠", 欠落の可能性: "⚠", 未整形: "⚠" };

export function toMarkdown(result: Result): string {
  const issues = cellIssues(result);
  const cell = (n: number, c: string, v: string) => {
    const s = v.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    const issue = issues.get(`${n}\u0000${c}`);
    if (!issue) return s || " ";
    return s ? `${s} ${MARKS[issue.kind]}` : MARKS[issue.kind];
  };
  const lines = [`| # | ${result.columns.join(" | ")} |`, `|---|${"---|".repeat(result.columns.length)}`];
  result.rows.forEach((row, i) => {
    lines.push(`| ${i + 1} | ${row.map((v, c) => cell(i + 1, result.columns[c], v)).join(" | ")} |`);
  });
  return lines.join("\n");
}

export function issuesMarkdown(result: Result, limit = 40): string {
  if (!result.issues.length) return "確認が必要な箇所はありません。";
  const lines = result.issues
    .slice(0, limit)
    .map((i) => `- ${i.row}行目「${i.column}」${MARKS[i.kind]} ${i.kind}: ${i.detail}`);
  if (result.issues.length > limit) lines.push(`- ほか ${result.issues.length - limit} 件（Excel の「確認リスト」シートを参照）`);
  return lines.join("\n");
}

const FILLS: Record<IssueKind, string> = { 補正: "FFFFF2B3", 要確認: "FFFFD6D6", 欠落の可能性: "FFFFD6D6", 未整形: "FFFFD6D6" };

export async function writeWorkbook(path: string, result: Result, originals: [string, Table][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("整形済み", { views: [{ state: "frozen", ySplit: 1 }] });
  const issues = cellIssues(result);
  result.columns.forEach((name, c) => {
    const cell = ws.getCell(1, c + 1);
    cell.value = name;
    cell.font = { bold: true };
    cell.border = THIN_BORDER;
  });
  result.rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const name = result.columns[c];
      const cell = ws.getCell(r + 2, c + 1);
      // Codes stay text so leading zeros survive
      cell.value = columnKind(name) ? value : typed(value);
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: true };
      const issue = issues.get(`${r + 1}\u0000${name}`);
      if (issue) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILLS[issue.kind] } };
        cell.note = `${issue.kind}: ${issue.detail}`;
      }
    });
  });
  result.columns.forEach((name, c) => {
    const width = Math.max(displayWidth(name), ...result.rows.map((r) => displayWidth(r[c] ?? "")));
    ws.getColumn(c + 1).width = Math.min(Math.max(width + 2, 6), 50);
  });

  const log = wb.addWorksheet("確認リスト");
  log.addRow(["行", "列", "種類", "内容"]).font = { bold: true };
  for (const i of result.issues) log.addRow([i.row, i.column, i.kind, i.detail]);
  [6, 12, 12, 80].forEach((w, c) => (log.getColumn(c + 1).width = w));

  for (const [name, table] of originals) addTableSheet(wb, `OCR原本_${name}`, table);
  await wb.xlsx.writeFile(path);
}
