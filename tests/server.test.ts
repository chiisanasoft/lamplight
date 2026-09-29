import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, safeStorage: {} }));

const { librechatYaml, preferredChatModel, serverEnv } = await import("../src/main/server/serverConfig");
const { mongoDownload } = await import("../src/main/server/mongo");

const secrets = {
  credsKey: "k", credsIv: "iv", jwtSecret: "j", jwtRefreshSecret: "jr", localPassword: "p", localAccountCreated: true,
};
const dirs = { logs: "/d/logs", uploads: "/d/up", images: "/d/img", publicDir: "/d", configPath: "/d/librechat.yaml", serverEnvPath: "/d/server.env", tempCredentials: "/d/t" };

describe("serverEnv", () => {
  const env = serverEnv({
    port: 38123,
    mongoUri: "mongodb://127.0.0.1:5000/Lamplight",
    secrets,
    dirs,
    base: { PATH: "/usr/bin", HOME: "/Users/me", NODE_OPTIONS: "--inspect", HTTP_PROXY: "http://proxy" },
  });

  it("binds the server to loopback on the chosen port", () => {
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("38123");
    expect(env.DOMAIN_CLIENT).toBe("http://127.0.0.1:38123");
    expect(env.MONGO_URI).toBe("mongodb://127.0.0.1:5000/Lamplight");
  });

  it("disables sign-up and points writable data at the user's folder", () => {
    expect(env.ALLOW_REGISTRATION).toBe("false");
    expect(env.LAMPLIGHT_UPLOADS_DIR).toBe("/d/up");
    expect(env.LAMPLIGHT_IMAGES_DIR).toBe("/d/img");
    expect(env.CONFIG_PATH).toBe("/d/librechat.yaml");
    expect(env.APP_TITLE).toBe("Lamplight");
  });

  it("does not inherit the user's Node or proxy settings", () => {
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("librechatYaml", () => {
  it("routes Ollama through the OCR proxy and allows it through the SSRF guard", () => {
    const yaml = librechatYaml(40111);
    expect(yaml).toContain("- '127.0.0.1:11434'");
    expect(yaml).toContain("- '127.0.0.1:40111'  # lamplight-ocr-proxy");
    expect(yaml).toContain('baseURL: "${LAMPLIGHT_OLLAMA_URL}"');
    expect(yaml).toContain('- "application/pdf"');
  });
});

describe("wireOcrProxy", () => {
  it("follows a changed proxy port", async () => {
    const { wireOcrProxy } = await import("../src/main/server/serverConfig");
    const out = wireOcrProxy(librechatYaml(40111), 40222);
    expect(out.wired).toBe(true);
    expect(out.yaml).toContain("'127.0.0.1:40222'  # lamplight-ocr-proxy");
    expect(out.yaml).not.toContain("40111");
  });

  it("upgrades the v0.2 file that talked to Ollama directly", async () => {
    const { wireOcrProxy } = await import("../src/main/server/serverConfig");
    const v02 = [
      "endpoints:",
      "  allowedAddresses:",
      "    - '127.0.0.1:11434'",
      "  custom:",
      '    - name: "Ollama"',
      '      baseURL: "http://127.0.0.1:11434/v1/"',
      "fileConfig:",
      "  endpoints:",
      "    Ollama:",
      "      supportedMimeTypes:",
      '        - "image/.*"',
      "",
    ].join("\n");
    const out = wireOcrProxy(v02, 40333);
    expect(out.wired).toBe(true);
    expect(out.yaml).toContain("    - '127.0.0.1:40333'  # lamplight-ocr-proxy\n    - '127.0.0.1:11434'");
    expect(out.yaml).toContain('baseURL: "${LAMPLIGHT_OLLAMA_URL}"');
    expect(out.yaml).toContain('        - "image/.*"\n        - "application/pdf"');
    expect(out.yaml).toContain('"application/pdf": "text"');
  });

  it("lets text uploads through and sends PDFs as text, also in v0.4 files", async () => {
    const { wireOcrProxy } = await import("../src/main/server/serverConfig");
    const fresh = librechatYaml(40111);
    expect(fresh).toContain('        - "application/pdf"\n        - "text/plain"\n      defaultLLMDeliveryPath:');
    expect(fresh).toContain('      defaultLLMDeliveryPath:\n        overrides:\n          "application/pdf": "text"');
    const v042 = fresh.replace('        - "text/plain"\n', "");
    const v041 = v042.replace(/ {6}defaultLLMDeliveryPath:\n.*\n.*\n/, "");
    expect(v041).not.toContain("defaultLLMDeliveryPath");
    for (const old of [v041, v042, fresh]) {
      const out = wireOcrProxy(old, 40111).yaml;
      expect(out).toBe(fresh);
      expect(wireOcrProxy(out, 40111).yaml).toBe(fresh);
    }
  });

  it("leaves a file the user rewrote alone", async () => {
    const { wireOcrProxy } = await import("../src/main/server/serverConfig");
    const custom = 'endpoints:\n  custom:\n    - name: "Ollama"\n      baseURL: "http://192.168.1.5:11434/v1/"\n';
    expect(wireOcrProxy(custom, 40444)).toEqual({ yaml: custom, wired: false });
  });
});

describe("mongoDownload", () => {
  it("uses the official macOS archives", () => {
    expect(mongoDownload("8.0.20", "darwin", "arm64")).toEqual({
      url: "https://fastdl.mongodb.org/osx/mongodb-macos-arm64-8.0.20.tgz",
      folder: "mongodb-macos-aarch64--8.0.20",
    });
    expect(mongoDownload("8.0.20", "darwin", "x64")?.url).toContain("mongodb-macos-x86_64-8.0.20.tgz");
  });

  it("picks the Linux build for the distribution", async () => {
    const { linuxTarget } = await import("../src/main/server/mongo");
    const os = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k}="${v}"`).join("\n");
    expect(mongoDownload("8.0.20", "linux", "x64", os({ ID: "ubuntu", VERSION_ID: "24.04", UBUNTU_CODENAME: "noble" }))).toEqual({
      url: "https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2404-8.0.20.tgz",
      folder: "mongodb-linux-x86_64-ubuntu2404-8.0.20",
    });
    expect(mongoDownload("8.0.20", "linux", "arm64", os({ ID: "ubuntu", VERSION_ID: "22.04" }))?.url).toContain("mongodb-linux-aarch64-ubuntu2204-8.0.20.tgz");
    // Derivatives and newer releases
    expect(linuxTarget(os({ ID: "linuxmint", ID_LIKE: "ubuntu debian", VERSION_ID: "22", UBUNTU_CODENAME: "jammy" }), "x64")).toBe("ubuntu2204");
    expect(linuxTarget(os({ ID: "ubuntu", VERSION_ID: "26.04", UBUNTU_CODENAME: "resolute" }), "x64")).toBe("ubuntu2404");
    expect(linuxTarget(os({ ID: "debian", VERSION_ID: "13" }), "x64")).toBe("debian12");
    expect(linuxTarget(os({ ID: "debian", VERSION_ID: "13" }), "arm64")).toBe("ubuntu2204");
    expect(linuxTarget(os({ ID: "rocky", ID_LIKE: "rhel centos fedora", VERSION_ID: "9.4" }), "x64")).toBe("rhel93");
    expect(linuxTarget(os({ ID: "almalinux", ID_LIKE: "rhel centos fedora", VERSION_ID: "8.10" }), "x64")).toBe("rhel8");
    expect(linuxTarget(os({ ID: "fedora", VERSION_ID: "42" }), "x64")).toBe("rhel93");
    expect(linuxTarget(os({ ID: "amzn", ID_LIKE: "fedora", VERSION_ID: "2023" }), "x64")).toBe("amazon2023");
    // No suitable build
    expect(linuxTarget(os({ ID: "debian", VERSION_ID: "11" }), "x64")).toBeNull();
    expect(linuxTarget(os({ ID: "arch" }), "x64")).toBeNull();
    expect(mongoDownload("8.0.20", "linux", "ia32", os({ ID: "ubuntu", VERSION_ID: "24.04" }))).toBeNull();
  });
});

describe("preferredChatModel", () => {
  it("skips OCR and embedding models that sort first", () => {
    expect(preferredChatModel(["glm-ocr:latest", "nemotron-nano-9b-ja:latest", "qwen3.5:9b"])).toBe("nemotron-nano-9b-ja:latest");
    expect(preferredChatModel(["nomic-embed-text:latest", "qwen3.5:9b"])).toBe("qwen3.5:9b");
    expect(preferredChatModel(["glm-ocr:latest"])).toBeUndefined();
    expect(preferredChatModel([])).toBeUndefined();
  });
});

describe("parseDotenv", () => {
  it("reads LibreChat's .env format", async () => {
    const { parseDotenv } = await import("../src/main/server/serverConfig");
    expect(parseDotenv([
      "# comment",
      "OPENAI_API_KEY=user_provided",
      'OPENID_SCOPE="openid profile email"',
      "OPENID_JWKS_URL_CACHE_TIME= # 600000 ms",
      'SCOPE="user.read" # trailing comment',
      "export DEBUG_LOGGING=true",
      "# ENDPOINTS=openAI,google",
      "EMPTY=",
    ].join("\n"))).toEqual({
      OPENAI_API_KEY: "user_provided",
      OPENID_SCOPE: "openid profile email",
      SCOPE: "user.read",
      DEBUG_LOGGING: "true",
    });
  });
});

describe("serverEnv layering", () => {
  it("applies LibreChat defaults, then server.env, but keeps required values", async () => {
    const { serverEnv } = await import("../src/main/server/serverConfig");
    const env = serverEnv({
      port: 38123,
      mongoUri: "mongodb://127.0.0.1:5000/Lamplight",
      secrets,
      dirs: { ...dirs, serverEnvPath: "/d/server.env" },
      base: {},
      librechatDefaults: { OPENAI_API_KEY: "user_provided", ANTHROPIC_API_KEY: "user_provided", HOST: "localhost", ALLOW_REGISTRATION: "true", SEARCH: "true" },
      userEnv: { ANTHROPIC_API_KEY: "sk-ant-x", PORT: "9999", CREDS_KEY: "evil", SEARCH: "true" },
    });
    expect(env.OPENAI_API_KEY).toBe("user_provided");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.SEARCH).toBe("true");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("38123");
    expect(env.CREDS_KEY).toBe("k");
    expect(env.ALLOW_REGISTRATION).toBe("false");
  });
});

describe("setManagedBlock", () => {
  it("adds, replaces and removes only its own block", async () => {
    const { setManagedBlock, ocrServiceBlock } = await import("../src/main/server/serverConfig");
    const base = "version: 1\nendpoints:\n  custom: []\n";
    const added = setManagedBlock(base, "ocr", ocrServiceBlock("glm-ocr", 40555));
    expect(added).toContain("# >>> lamplight: ocr\n# Documents");
    expect(added).toContain('baseURL: "${LAMPLIGHT_OCR_BASEURL}"');
    expect(added).toContain("  allowedAddresses:\n    - '127.0.0.1:40555'");
    expect(setManagedBlock(added, "ocr", ocrServiceBlock("glm-ocr", 40555))).toBe(added);
    expect(setManagedBlock(added, "ocr", null)).toBe(base);
    expect(setManagedBlock(base, "ocr", null)).toBe(base);
  });
});
