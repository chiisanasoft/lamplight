import ExcelJS from "exceljs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as fmt from "../src/formatter";
import { inferHeaders } from "../src/headers";
import { ocrPrompt, repetitionStart, requestedPages } from "../src/ocr";
import { fixRadicals, pageIndexes } from "../src/pdf";
import { convertHtmlTables } from "../src/tables";

describe("headers", () => {
  it("labels ledger columns and ignores repeated labels", () => {
    const grid = [
      ["7/12", "信金", "山田", "太郎", "100-0001", "千代田区丸の内1-1", "03-1234-5678"],
      ["7/15", "信金", "佐藤", "花子", "530-0001", "大阪市北区梅田2-3", "06-2345-6789"],
      ["8/02", "信金", "鈴木", "一郎", "460-0002", "名古屋市中区栄3-4", "052-345-6789"],
    ];
    expect(inferHeaders(grid)).toEqual(["日付", "列2", "姓", "名", "郵便番号", "住所", "電話番号"]);
  });

  it("keeps an existing header, recognizes full names and 和暦", () => {
    expect(inferHeaders([["日付", "氏名", "住所"], ["1/2", "山田太郎", "港区1-1"]])).toBeNull();
    expect(inferHeaders([["山田 太郎", "R8.7.6"], ["佐藤 花子", "令和8年7月8日"]])).toEqual(["氏名", "日付"]);
    expect(inferHeaders([["apple", "3"], ["pear", "5"]])).toBeNull();
  });
});

describe("tables", () => {
  it("converts HTML tables with spans to Markdown", () => {
    const html = '<table><tr><th colspan="2">氏名</th><th>電話</th></tr><tr><td rowspan="2">A|B</td><td>x<br>y</td><td>028-000-0000</td></tr><tr><td>z</td><td>1</td></tr></table>';
    const { text, tables } = convertHtmlTables(`前文\n${html}\n後文`);
    expect(tables).toHaveLength(1);
    expect(text).toContain("| A\\|B | x<br>y | 028-000-0000 |");
    expect(tables[0].grid().merges).toEqual([[0, 0, 0, 1], [1, 0, 2, 0]]);
  });
});

describe("ocr helpers", () => {
  it("maps requests to glm-ocr task prompts", () => {
    expect(ocrPrompt("1ページ目を表にして")).toBe("Table Recognition:");
    expect(ocrPrompt("数式を読んで")).toBe("Formula Recognition:");
    expect(ocrPrompt("読み取って")).toBe("Text Recognition:");
    expect(ocrPrompt("Table Recognition:")).toBe("Table Recognition:");
  });

  it("parses page hints", () => {
    expect(requestedPages("extract the first page")).toEqual([1]);
    expect(requestedPages("2ページ目を")).toEqual([2]);
    expect(requestedPages("1〜3ページ")).toEqual([1, 2, 3]);
    expect(requestedPages("全部")).toBeNull();
    expect(pageIndexes(7, [2, 9], 20)).toEqual([1]);
    expect(pageIndexes(30, null, 20)).toHaveLength(20);
  });

  it("cuts a trailing loop back to where it started", () => {
    const table = "<table>" + "<tr><td>a</td><td></td></tr>".repeat(30) + "</table>";
    const looped = table + ": [table]".repeat(80);
    expect(repetitionStart(looped)).toBe(table.length);
    expect(repetitionStart(table)).toBeNull();
  });

  it("fixes Kangxi radicals from PDF text layers only", () => {
    expect(fixRadicals("⾒積書 ⾦額 ＡＢＣ１２３")).toBe("見積書 金額 ＡＢＣ１２３");
  });
});

describe("formatter", () => {
  it("parses a template from the chat or falls back", () => {
    expect(fmt.parseTemplate("整形して 列: 日付, 氏名、住所", ["x"])).toEqual(["日付", "氏名", "住所"]);
    expect(fmt.parseTemplate("整形して", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("splits date cells by rule", () => {
    const row = new fmt.SourceRow(1, { 日付: "7/1A7/3B", 日付2: "8・5C", 氏名: "山田太郎" });
    expect(fmt.splitDates(row)).toEqual(["7/1", ["A", "7/3B", "8/5C"]]);
  });

  it("normalizes and validates", () => {
    expect(fmt.normalize("1000001", "postal")).toBe("100-0001");
    expect(fmt.normalize("０３－１２３４－５６７８", "phone")).toBe("03-1234-5678");
    expect(fmt.invalid("090-12345678", "phone")).toBe("電話番号の形式ではありません");
    expect(fmt.invalid("13/40", "date")).toBe("日付の形式ではありません");
  });

  it("flags corrections and dropped characters, and falls back when the LLM skipped a row", () => {
    const src = [new fmt.SourceRow(1, { 日付: "7/1A", 氏名: "山田太郎", 住所: "千代田区丸の内1-1", 列4: "X9" })];
    const shaped = new Map([[0, { src: 0, 姓: "山田", 名: "太郎", 住所: "千代田区丸ノ内1-1", 備考: "" }]]);
    const r = fmt.finalize(["日付", "姓", "名", "住所", "備考"], src, shaped, ["日付", "氏名", "住所", "列4"]);
    expect(r.rows[0]).toEqual(["7/1", "山田", "太郎", "千代田区丸ノ内1-1", "A"]);
    const kinds = r.issues.map((i) => `${i.column}:${i.kind}`);
    expect(kinds).toContain("住所:補正");
    expect(kinds).toContain("備考:欠落の可能性");
    const r2 = fmt.finalize(["住所"], [new fmt.SourceRow(1, { 住所: "港区1-1" })], new Map(), ["住所"]);
    expect(r2.rows).toEqual([["港区1-1"]]);
    expect(r2.issues[0].kind).toBe("未整形");
  });

  it("writes the formatted, review and original sheets", async () => {
    const src = [new fmt.SourceRow(1, { 電話: "03-1234-5678" })];
    const r = fmt.finalize(["電話番号"], src, new Map([[0, { src: 0, 電話番号: "03-1234-5678" }]]), ["電話"]);
    const { tables } = convertHtmlTables("<table><tr><td>03-1234-5678</td></tr><tr><td>06-1234-5678</td></tr></table>");
    const path = join(mkdtempSync(join(tmpdir(), "lamplight-ocr-")), "out.xlsx");
    await fmt.writeWorkbook(path, r, [["P1", tables[0]]]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["整形済み", "確認リスト", "OCR原本_P1"]);
    expect(wb.getWorksheet("整形済み")!.getCell("A2").value).toBe("03-1234-5678");
  });
});

describe("ocr service", () => {
  it("parses a multipart upload like LibreChat's form-data client sends", async () => {
    const { parseMultipartFile } = await import("../src/ocrService");
    const boundary = "----formdata-123";
    const pdf = Buffer.from("%PDF-1.4 fake\r\nbinary\x00\x01");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nocr\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="%E5%8F%B0%E5%B8%B3.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const f = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);
    expect(f?.name).toBe("台帳.pdf");
    expect(f?.mime).toBe("application/pdf");
    expect(f?.data.equals(pdf)).toBe(true);
  });
});
