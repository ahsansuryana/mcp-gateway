import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../utils/logger.js";

/** Penyimpanan token OAuth ke backend (file JSON, izin 0600). */
export class TokenStore {
  constructor(path) {
    this.path = path;
    this.data = {};
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        log("WARN", `token store ${path} rusak, mulai dari kosong`);
      }
    }
  }
  get(name) {
    return this.data[name] ?? {};
  }
  update(name, patch) {
    this.data[name] = { ...this.get(name), ...patch };
    this.flush();
  }
  remove(name, keys) {
    const cur = { ...this.get(name) };
    for (const k of keys) delete cur[k];
    this.data[name] = cur;
    this.flush();
  }
  flush() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
