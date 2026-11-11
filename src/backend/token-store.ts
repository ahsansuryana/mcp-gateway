import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "../utils/logger.js";

export interface StoredAuth {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
}

/** Penyimpanan token OAuth backend: file JSON dengan izin 0600. */
export class TokenStore {
  private data: Record<string, StoredAuth> = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        log("WARN", `token store ${path} rusak, mulai dari kosong`);
      }
    }
  }

  get(name: string): StoredAuth {
    return this.data[name] ?? {};
  }

  update(name: string, patch: Partial<StoredAuth>): void {
    this.data[name] = { ...this.get(name), ...patch };
    this.flush();
  }

  remove(name: string, keys: (keyof StoredAuth)[]): void {
    const cur = { ...this.get(name) };
    for (const k of keys) delete cur[k];
    this.data[name] = cur;
    this.flush();
  }

  private flush(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
