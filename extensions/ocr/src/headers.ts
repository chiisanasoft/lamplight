/**
 * Infers column headers (日付, 姓, 名, 郵便番号, 住所, …) for OCR'd tables that have none.
 *
 * Each column is classified from its non-empty values; a column gets a type when most values
 * match it. A header row is only added when the first row does not already look like one.
 */

const KANJI = "\\u4e00-\\u9fff\\u3005\\u30f6"; // CJK ideographs, 々, ヶ

// Checked in order; the first matching type wins for a cell
const CELL_TYPES: [string, RegExp][] = [
  ["郵便番号", /^〒?\s*\d{3}\s*-\s*\d{4}$/u],
  ["電話番号", /(?<!\d)0\d{1,4}\s*[-(（)）]\s*\d{1,4}\s*-?\s*\d{3,8}(?!\d)|(?<!\d)0\d{9,10}(?!\d)/u],
  ["日付", /^(?:(?:\d{4}|[RHSrhs令平昭][\p{L}\p{N}]{0,2}\d{1,2})\s*[/／.．年-]\s*)?\d{1,2}\s*[/／・.．月]\s*\d{1,2}(?!\d)/u],
  ["住所", new RegExp(`^(?:東京都|北海道|(?:京都|大阪)府|[${KANJI}]{2,3}県)?[${KANJI}ぁ-んァ-ン]{1,6}[市区郡町村].*\\d`, "u")],
  ["氏名", new RegExp(`^[${KANJI}]{2,3}\\s+[${KANJI}]{1,3}$|^[${KANJI}]{4,6}$`, "u")],
  ["名前", new RegExp(`^[${KANJI}]{1,3}$`, "u")],
];

const HEADER_WORDS = /日付|年月日|氏名|名前|姓|名|郵便|〒|住所|所在地|電話|TEL|tel|番号|備考|No\.?$/u;

const MATCH_RATIO = 0.6;
const MIN_VALUES = 2;
const NAME_MIN_UNIQUE_RATIO = 0.5; // rejects repeated labels such as "信金" posing as names

function cellType(value: string): string | null {
  const v = value.trim();
  for (const [name, pattern] of CELL_TYPES) if (pattern.test(v)) return name;
  return null;
}

export function classifyColumn(values: string[]): string | null {
  const vals = values.map((v) => (v ?? "").trim()).filter(Boolean);
  if (vals.length < MIN_VALUES) return null;
  const counts = new Map<string, number>();
  for (const v of vals) {
    const t = cellType(v);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const [best, n] = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
  if (n / vals.length < MATCH_RATIO) return null;
  if ((best === "名前" || best === "氏名") && new Set(vals).size / vals.length < NAME_MIN_UNIQUE_RATIO) return null;
  return best;
}

export function looksLikeHeader(row: string[]): boolean {
  const filled = row.filter((c) => c.trim());
  if (!filled.length) return false;
  const hits = filled.filter((c) => c.length <= 8 && HEADER_WORDS.test(c)).length;
  return hits / filled.length >= 0.5;
}

/** Header labels for a grid without a header row, or null when it already has one. */
export function inferHeaders(grid: string[][]): string[] | null {
  if (!grid.length || looksLikeHeader(grid[0])) return null;
  const nCols = grid[0].length;
  const types = Array.from({ length: nCols }, (_, c) => classifyColumn(grid.map((row) => row[c] ?? "")));
  if (!types.some(Boolean)) return null;

  const labels: string[] = [];
  types.forEach((t, c) => {
    let label = t;
    if (t === "名前") {
      // Two adjacent short-name columns are 姓 + 名; a lone one is a full name
      if (c + 1 < nCols && types[c + 1] === "名前" && (c === 0 || types[c - 1] !== "名前")) label = "姓";
      else if (c > 0 && types[c - 1] === "名前" && labels[labels.length - 1] === "姓") label = "名";
      else label = "氏名";
    }
    labels.push(label ?? `列${c + 1}`);
  });

  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n > 1 ? `${label}${n}` : label;
  });
}
