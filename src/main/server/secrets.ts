import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";

export interface Secrets {
  credsKey: string;
  credsIv: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  /** Password of the local account Lamplight signs in with */
  localPassword: string;
  localAccountCreated: boolean;
}

export function generateSecrets(): Secrets {
  const hex = (n: number) => randomBytes(n).toString("hex");
  return {
    credsKey: hex(32),
    credsIv: hex(16),
    jwtSecret: hex(32),
    jwtRefreshSecret: hex(32),
    localPassword: randomBytes(24).toString("base64url"),
    localAccountCreated: false,
  };
}

/** secrets.bin exists but cannot be decrypted (typically the keychain entry protecting it is gone). */
export class SecretsUnreadableError extends Error {}

/**
 * Per-install secrets, encrypted with the OS keychain (safeStorage) when available.
 * The file is also restricted to the current user.
 */
export class SecretStore {
  constructor(private readonly path: string) {}

  load(): Secrets {
    if (existsSync(this.path)) {
      const raw = readFileSync(this.path);
      try {
        const json = raw.subarray(0, 4).toString() === "enc:"
          ? safeStorage.decryptString(raw.subarray(4))
          : raw.toString("utf8");
        return JSON.parse(json) as Secrets;
      } catch (err) {
        throw new SecretsUnreadableError(err instanceof Error ? err.message : String(err));
      }
    }
    const secrets = generateSecrets();
    this.save(secrets);
    return secrets;
  }

  /** Moves an unreadable secrets.bin aside (kept in case the keychain entry comes back) so new secrets can be made. */
  setAside(): string {
    const target = `${this.path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(this.path, target);
    return target;
  }

  save(secrets: Secrets) {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(secrets);
    const data = safeStorage.isEncryptionAvailable()
      ? Buffer.concat([Buffer.from("enc:"), safeStorage.encryptString(json)])
      : Buffer.from(json);
    writeFileSync(this.path, data, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
