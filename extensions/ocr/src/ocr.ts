/** Running an OCR model on one image: prompt mapping, page hints, loop guard and cache. */
import { createHash } from "node:crypto";

export const OCR_TASK_PROMPTS = ["Text Recognition:", "Table Recognition:", "Formula Recognition:"] as const;

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export function ocrPrompt(text: string): string {
  const stripped = text.trim();
  for (const p of OCR_TASK_PROMPTS) if (stripped.startsWith(p)) return p;
  const t = stripped.toLowerCase();
  if (/table|表/.test(t)) return "Table Recognition:";
  if (/formula|equation|latex|数式/.test(t)) return "Formula Recognition:";
  return "Text Recognition:";
}

/** Parses page hints such as "first page", "page 3", "2ページ目", "1〜3ページ". */
export function requestedPages(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/\bfirst page\b|最初のページ|1枚目/.test(t)) return [1];
  const m = /(\d+)\s*[-~〜～]\s*(\d+)\s*ページ|pages?\s*(\d+)\s*-\s*(\d+)/.exec(t);
  if (m) {
    const a = Number(m[1] ?? m[3]);
    const b = Number(m[2] ?? m[4]);
    return Array.from({ length: Math.max(b - a + 1, 0) }, (_, i) => a + i);
  }
  const pages = new Set<number>();
  for (const x of t.matchAll(/(\d+)\s*ページ目|\bpage\s*(\d+)/g)) pages.add(Number(x[1] ?? x[2]));
  return pages.size ? [...pages].sort((a, b) => a - b) : null;
}

const REPEAT_MIN_SPAN = 300; // chars of back-to-back repetition treated as a loop
const REPEAT_MIN_COUNT = 10;
const REPEAT_MAX_UNIT = 60;
const HOLD_BACK = 600; // chars withheld while streaming so a loop can be cut before it is sent

/** Index where a trailing loop (one unit repeated back-to-back) begins, if any. */
export function repetitionStart(text: string): number | null {
  const tail = text.slice(-(REPEAT_MIN_SPAN * 2));
  for (let size = 1; size <= REPEAT_MAX_UNIT; size++) {
    const unit = tail.slice(-size);
    let count = 0;
    let pos = tail.length;
    while (pos >= size && tail.slice(pos - size, pos) === unit) {
      count++;
      pos -= size;
    }
    if (count >= REPEAT_MIN_COUNT && count * size >= REPEAT_MIN_SPAN) {
      // The loop may extend past the inspected tail; walk back over the full text
      let p = text.length - count * size;
      while (p >= size && text.slice(p - size, p) === unit) p -= size;
      return p;
    }
  }
  return null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
export const newUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

/** Streams OCR text for one image, cutting the output when the model starts looping. */
export async function* ocrPage(opts: {
  upstream: string;
  model: string;
  image: ImagePart;
  prompt: string;
  maxTokens: number;
  usage?: Usage;
}): AsyncGenerator<string> {
  const res = await fetch(`${opts.upstream}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: opts.maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: [opts.image, { type: "text", text: opts.prompt }] }],
    }),
  });
  if (!res.ok || !res.body) {
    yield `[OCR error: ${res.status} ${await res.text().catch(() => "")}]`;
    return;
  }
  let text = "";
  let sent = 0;
  let pending = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    reading: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: {")) continue;
        const data = JSON.parse(line.slice(6)) as { usage?: Usage; choices?: { delta?: { content?: string } }[] };
        if (data.usage && opts.usage) {
          for (const k of Object.keys(opts.usage) as (keyof Usage)[]) opts.usage[k] += data.usage[k] ?? 0;
        }
        for (const c of data.choices ?? []) text += c.delta?.content ?? "";
        const cut = repetitionStart(text);
        if (cut !== null) {
          text = text.slice(0, cut);
          break reading;
        }
        if (text.length - HOLD_BACK > sent) {
          yield text.slice(sent, text.length - HOLD_BACK);
          sent = text.length - HOLD_BACK;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (text.length > sent) yield text.slice(sent);
}

const cache = new Map<string, string>();
const CACHE_SIZE = 64;

/** Full OCR text for one image. Cached, since LibreChat resends attachments on every turn. */
export async function ocrText(opts: Parameters<typeof ocrPage>[0]): Promise<string> {
  const key = createHash("sha256").update(`${opts.model}\0${opts.prompt}\0${opts.image.image_url.url}`).digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let text = "";
  for await (const t of ocrPage(opts)) text += t;
  if (!text.startsWith("[OCR error")) {
    cache.set(key, text);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  }
  return text;
}
