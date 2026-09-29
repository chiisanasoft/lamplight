// Builds Lamplight and uploads it to the v<version> release of chiisanasoft/lamplight.
// The release is created first with gh: when electron-builder's parallel uploads (.dmg and .zip)
// each try to create it, one of them fails with "422 Published releases must have a valid tag".
//
// Usage: GH_TOKEN=$(gh auth token) node scripts/release-app.mjs --mac | --linux [electron-builder args]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "chiisanasoft/lamplight";
const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tag = `v${version}`;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is not set (GH_TOKEN=$(gh auth token))");
try {
  execFileSync("gh", ["release", "view", tag, "-R", REPO], { stdio: "ignore" });
} catch {
  run("gh", ["release", "create", tag, "-R", REPO, "--title", `Lamplight ${version}`, "--notes", `Lamplight ${version}`]);
}
run("npm", ["run", "build"]);
run("npx", ["electron-builder", ...process.argv.slice(2), "--publish", "always"]);
