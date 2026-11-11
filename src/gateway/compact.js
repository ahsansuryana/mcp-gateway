export const shorten = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!n || s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
};

const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
const RAW_KEYS = new Set(["default", "enum", "const", "examples", "required"]); // data, jangan disentuh

export function stripSchema(node) {
  if (Array.isArray(node)) return node.map(stripSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" || k === "title") continue;
    if (SCHEMA_MAPS.has(k) && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, stripSchema(pv)]));
    } else if (RAW_KEYS.has(k)) out[k] = v;
    else out[k] = stripSchema(v);
  }
  return out;
}

/** Kembalikan fungsi compactTool(tool) sesuai blok `compact` di config (tanpa blok = tool apa adanya). */
export function createCompactor({ compactCfg, maxDesc }) {
  return function compactTool(t) {
    if (!compactCfg) return t;
    const out = { ...t };
    if (maxDesc > 0) out.description = shorten(t.description, maxDesc);
    delete out.title;
    delete out.icons;
    if (compactCfg.strip_param_descriptions) out.inputSchema = stripSchema(t.inputSchema);
    if (compactCfg.strip_output_schema ?? true) delete out.outputSchema;
    return out;
  };
}
