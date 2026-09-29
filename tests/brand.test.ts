import { describe, expect, it } from "vitest";
import { brandCss, brandTitle } from "../src/main/brand";

describe("brandTitle", () => {
  it("replaces LibreChat's default name", () => {
    expect(brandTitle("LibreChat")).toBe("Lamplight");
    expect(brandTitle("旅行の計画 | LibreChat")).toBe("旅行の計画 | Lamplight");
    expect(brandTitle("")).toBe("Lamplight");
  });

  it("keeps a server's own APP_TITLE", () => {
    expect(brandTitle("社内AI")).toBe("社内AI");
  });
});

describe("brandCss", () => {
  it("swaps the login logo and hides only the default footer", () => {
    const css = brandCss("data:image/svg+xml;base64,AAA");
    expect(css).toContain('img[src$="assets/logo.svg"] { content: url("data:image/svg+xml;base64,AAA"); }');
    expect(css).toContain('a[href="https://librechat.ai"]');
  });
});
