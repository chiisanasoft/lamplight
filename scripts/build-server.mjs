// Builds the LibreChat server that ships inside Lamplight: node scripts/build-server.mjs
//
// 1. Checks out the pinned LibreChat release in vendor/librechat and applies patches/librechat/*.patch
// 2. Builds the web client and shared packages
// 3. Brands the built client (title, logo, icons, manifest) as Lamplight
// 4. Stages a production copy in resources/server with only the api workspace's runtime dependencies
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.lamplight.librechatVersion;
const vendor = join(root, "vendor", "librechat");
const stage = join(root, "resources", "server");
const patches = join(root, "patches", "librechat");

const run = (cmd, args, cwd, env = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
};

// 1. pinned source + patches
if (!existsSync(vendor)) {
  run("git", ["clone", "--depth", "1", "--branch", version, "https://github.com/danny-avila/LibreChat.git", vendor], root);
} else {
  run("git", ["fetch", "--depth", "1", "origin", "tag", version], vendor);
  run("git", ["checkout", "-f", version], vendor);
}
for (const patch of readdirSync(patches).filter((f) => f.endsWith(".patch")).sort()) {
  // checkout -f keeps untracked files, so files a patch adds are removed before it is applied again
  const added = readFileSync(join(patches, patch), "utf8").matchAll(/^--- \/dev\/null\n\+\+\+ b\/(.+)$/gm);
  for (const [, file] of added) rmSync(join(vendor, file), { force: true });
  run("git", ["apply", join(patches, patch)], vendor);
}

// 2. build
run("npm", ["ci", "--no-audit", "--no-fund"], vendor);
run("npm", ["run", "frontend"], vendor, { LAMPLIGHT_DISABLE_PWA: "true" });

// 3. branding of the built client
const dist = join(vendor, "client", "dist");
cpSync(join(root, "build", "logo.svg"), join(dist, "assets", "logo.svg"));
for (const icon of ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon-180x180.png", "icon-192x192.png", "maskable-icon.png"]) {
  cpSync(join(root, "build", "web", icon), join(dist, "assets", icon));
}
const indexHtml = join(dist, "index.html");
writeFileSync(indexHtml, readFileSync(indexHtml, "utf8").replace(/<title>[^<]*<\/title>/, "<title>Lamplight</title>"));
// The PWA manifest only exists when the service worker is enabled
const manifestPath = join(dist, "manifest.webmanifest");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  Object.assign(manifest, { name: "Lamplight", short_name: "Lamplight", theme_color: "#211A14" });
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

// 4. production stage: the api workspace's runtime dependencies only
rmSync(stage, { recursive: true, force: true });
const skip = new Set(["node_modules", ".git", ".github", "e2e", "helm", "docs", "src", "redis-config", "utils", "search"]);
cpSync(vendor, stage, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(vendor.length + 1);
    if (!rel) return true;
    const top = rel.split("/")[0];
    if (skip.has(top)) return false;
    if (rel.split("/").includes("node_modules")) return false;
    if (rel === "client/src" || rel.startsWith("client/src/")) return false;
    return true;
  },
});
run("npm", ["ci", "--omit=dev", "--workspace=api", "--include-workspace-root=false", "--no-audit", "--no-fund"], stage);
writeFileSync(join(stage, "LAMPLIGHT_BUILD.json"), JSON.stringify({
  librechat: version,
  patches: readdirSync(patches).filter((f) => f.endsWith(".patch")).sort(),
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(`\nLibreChat ${version} staged in resources/server`);
