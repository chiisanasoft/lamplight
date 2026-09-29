import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, DEFAULT_CONFIG, normalizeServerUrl, sanitizeConfig } from "../src/main/config";

describe("normalizeServerUrl", () => {
  it("adds a scheme and drops trailing slashes", () => {
    expect(normalizeServerUrl("localhost:3081/")).toBe("http://localhost:3081");
    expect(normalizeServerUrl(" https://chat.example.com/app// ")).toBe("https://chat.example.com/app");
  });
});

describe("sanitizeConfig", () => {
  it("falls back to defaults for garbage", () => {
    expect(sanitizeConfig("nope")).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig({ serverUrl: 3, notifyOnComplete: "yes" })).toEqual(DEFAULT_CONFIG);
  });

  it("keeps valid favorites and fills missing labels", () => {
    const c = sanitizeConfig({
      favorites: [
        { endpoint: "Ollama", model: "qwen3.5:9b" },
        { label: "broken", endpoint: "", model: "x" },
        null,
      ],
      defaultFavorite: 0,
    });
    expect(c.favorites).toEqual([{ label: "qwen3.5:9b", endpoint: "Ollama", model: "qwen3.5:9b" }]);
    expect(c.defaultFavorite).toBe(0);
  });

  it("resets an out-of-range default favorite", () => {
    expect(sanitizeConfig({ favorites: [], defaultFavorite: 3 }).defaultFavorite).toBe(-1);
  });

  it("checks for updates unless turned off", () => {
    expect(sanitizeConfig({}).checkForUpdates).toBe(true);
    expect(sanitizeConfig({ checkForUpdates: false }).checkForUpdates).toBe(false);
    expect(sanitizeConfig({ checkForUpdates: "no" }).checkForUpdates).toBe(true);
  });
});

describe("ConfigStore", () => {
  it("persists updates", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lamplight-")), "config.json");
    new ConfigStore(path).update({ serverUrl: "localhost:3081", launchAtLogin: true });
    expect(JSON.parse(readFileSync(path, "utf8")).serverUrl).toBe("http://localhost:3081");
    expect(new ConfigStore(path).get().launchAtLogin).toBe(true);
  });
});

describe("serverMode", () => {
  it("defaults to the embedded server", () => {
    expect(sanitizeConfig({}).serverMode).toBe("embedded");
  });

  it("keeps v0.1 settings that point at a server in external mode", () => {
    expect(sanitizeConfig({ serverUrl: "http://localhost:3081" }).serverMode).toBe("external");
    expect(sanitizeConfig({ serverUrl: "http://localhost:3080" }).serverMode).toBe("embedded");
  });

  it("respects an explicit mode and validates the port", () => {
    const c = sanitizeConfig({ serverMode: "embedded", serverUrl: "http://localhost:3081", embeddedPort: 38123 });
    expect(c.serverMode).toBe("embedded");
    expect(c.embeddedPort).toBe(38123);
    expect(sanitizeConfig({ embeddedPort: 80 }).embeddedPort).toBeUndefined();
  });
});
