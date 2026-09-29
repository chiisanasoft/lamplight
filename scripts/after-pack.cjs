// electron-builder afterPack hook: copies the embedded LibreChat server (resources/server) into the
// packaged app. extraResources cannot be used because electron-builder always drops node_modules there.
const { cpSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const host = platform === process.platform && arch === process.arch;
  // resources/server has the host's native packages; other targets use their own stage
  const name = host ? "server" : `server-${platform}-${arch}`;
  const source = join(context.packager.projectDir, "resources", name);
  if (!existsSync(source)) {
    throw new Error(`resources/${name} is missing; run \`npm run build:server\`${host ? "" : ` and \`node scripts/stage-server-${platform}.mjs ${arch}\``} first`);
  }
  const resources =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");
  const target = join(resources, "server");
  rmSync(target, { recursive: true, force: true });
  // verbatimSymlinks keeps the npm workspace links (node_modules/@librechat/* -> ../../packages/*) relative
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  console.log(`  • embedded server copied  source=resources/${name} target=${target}`);
};
