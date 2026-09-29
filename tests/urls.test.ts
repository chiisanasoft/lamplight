import { describe, expect, it } from "vitest";
import { buildNewChatUrl, isServerUrl, responseStreamId } from "../src/main/urls";

const server = "http://localhost:3081";
const qwen = { label: "Qwen", endpoint: "Ollama", model: "qwen3.5:9b" };

describe("buildNewChatUrl", () => {
  it("opens an empty new chat", () => {
    expect(buildNewChatUrl(server)).toBe("http://localhost:3081/c/new");
  });

  it("sets model and auto-submits the prompt", () => {
    const url = new URL(buildNewChatUrl(server, { favorite: qwen, prompt: "  要約して & 翻訳  " }));
    expect(url.pathname).toBe("/c/new");
    expect(url.searchParams.get("endpoint")).toBe("Ollama");
    expect(url.searchParams.get("model")).toBe("qwen3.5:9b");
    expect(url.searchParams.get("prompt")).toBe("要約して & 翻訳");
    expect(url.searchParams.get("submit")).toBe("true");
  });

  it("can fill the prompt without sending", () => {
    const url = new URL(buildNewChatUrl(server, { prompt: "draft", submit: false }));
    expect(url.searchParams.has("submit")).toBe(false);
  });

  it("keeps a sub-path deployment", () => {
    expect(buildNewChatUrl("https://example.com/chat")).toBe("https://example.com/chat/c/new");
  });
});

describe("isServerUrl", () => {
  it("compares origins", () => {
    expect(isServerUrl(server, "http://localhost:3081/c/abc")).toBe(true);
    expect(isServerUrl(server, "http://localhost:3082/exports/x.xlsx")).toBe(false);
    expect(isServerUrl(server, "https://github.com")).toBe(false);
    expect(isServerUrl(server, "not a url")).toBe(false);
  });
});

describe("responseStreamId", () => {
  it("extracts the stream id of LibreChat responses", () => {
    expect(responseStreamId(server, `${server}/api/agents/chat/stream/abc%2D1?resume=1`)).toBe("abc-1");
    expect(responseStreamId(server, `${server}/api/agents/chat/abort`)).toBeNull();
    expect(responseStreamId(server, "http://other:3081/api/agents/chat/stream/x")).toBeNull();
  });
});
