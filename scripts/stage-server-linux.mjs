// Stages the embedded server for Linux: resources/server-linux-<arch>.
//
// resources/server (from build-server.mjs) holds the host's native packages (sharp, @napi-rs/canvas),
// so its production dependencies are installed again inside a Linux container (Docker). The built
// client and the patched sources are platform-independent and copied as they are.
//
// Usage: node scripts/stage-server-linux.mjs [x64|arm64]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const arch = process.argv[2] ?? "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported arch: ${arch}`);
const root = resolve(import.meta.dirname, "..");
const source = join(root, "resources", "server");
const stage = join(root, "resources", `server-linux-${arch}`);
if (!existsSync(join(source, "LAMPLIGHT_BUILD.json"))) throw new Error("resources/server is missing; run `npm run build:server` first");

rmSync(stage, { recursive: true, force: true });
cpSync(source, stage, {
  recursive: true,
  verbatimSymlinks: true,
  filter: (src) => !src.slice(source.length).split("/").includes("node_modules"),
});

const platform = arch === "x64" ? "linux/amd64" : "linux/arm64";
const args = ["run", "--rm", "--platform", platform, "-v", `${stage}:/srv`, "-w", "/srv", "node:24-bookworm",
  "npm", "ci", "--omit=dev", "--workspace=api", "--include-workspace-root=false", "--no-audit", "--no-fund"];
console.log(`$ docker ${args.join(" ")}`);
execFileSync("docker", args, { stdio: "inherit" });
console.log(`\nEmbedded server for linux-${arch} staged in resources/server-linux-${arch}`);
