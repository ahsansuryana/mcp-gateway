import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CompactConfig } from "../config/types.js";

/** Rapikan whitespace dan potong di batas kata (n = 0 -> tidak dipotong). */
export function shorten(s: unknown, n: number): string {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!n || str.length <= n) return str;
  const cut = str.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
const RAW_KEYS = new Set(["default", "enum", "const", "examples", "required"]); // data, jangan disentuh

/** Buang `description` dan `title` dari JSON schema (struktur dan data tetap). */
export function stripSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" || k === "title") continue;
    if (SCHEMA_MAPS.has(k) && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, stripSchema(pv)]));
    } else if (RAW_KEYS.has(k)) {
      out[k] = v;
    } else {
      out[k] = stripSchema(v);
    }
  }
  return out;
}

export interface Compactor {
  /** Panjang maksimum deskripsi (0 = utuh). */
  readonly maxDescription: number;
  compactTool(t: Tool): Tool;
}

/** Pemadatan daftar tool; tanpa blok `compact` di config, tool dikembalikan apa adanya. */
export function createCompactor(cfg: CompactConfig | null | undefined): Compactor {
  const maxDescription = cfg?.max_description ?? 0;
  return {
    maxDescription,
    compactTool(t) {
      if (!cfg) return t;
      const out: Record<string, unknown> = { ...t };
      if (maxDescription > 0) out.description = shorten(t.description, maxDescription);
      delete out.title;
      delete out.icons;
      if (cfg.strip_param_descriptions) out.inputSchema = stripSchema(t.inputSchema);
      if (cfg.strip_output_schema ?? true) delete out.outputSchema;
      return out as unknown as Tool;
    },
  };
}
