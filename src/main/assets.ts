import { join } from "node:path";

/** Path of a file in build/, resolved from the compiled code (dist/main) so it works in dev and in app.asar. */
export function assetPath(name: string): string {
  return join(__dirname, "..", "..", "build", name);
}
