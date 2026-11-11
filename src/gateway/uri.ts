/**
 * Penulisan ulang URI resource agar tidak bentrok antar backend.
 *
 * Skema asli dipertahankan (penting untuk `ui://`, yang dikenali host dari skemanya),
 * nama backend disisipkan sebagai host, dan sisa URI asli ditaruh sebagai path:
 *
 *   ui://app/widget      (backend "docs") -> ui://docs/app/widget
 *   file:///a.txt        (backend "docs") -> file://docs//a.txt
 *   mailto:x@y.z         (backend "docs") -> mailto://docs/@opaque/x@y.z
 *
 * Fungsinya murni dan bisa dibalik tepat (wrapUri lalu unwrapUri menghasilkan URI asli),
 * jadi gateway tidak perlu menyimpan tabel pemetaan dan tetap stateless.
 */

const SCHEME = "[A-Za-z][A-Za-z0-9+.-]*";
const ORIGINAL = new RegExp(`^(${SCHEME}):(//)?([\\s\\S]*)$`);
const WRAPPED = new RegExp(`^(${SCHEME})://([^/]+)(?:/([\\s\\S]*))?$`);

/** Penanda untuk URI tanpa "//" (mailto:, urn:, dst). */
const OPAQUE = "@opaque/";

/** Tulis ulang URI backend menjadi URI gateway. null bila bukan URI bersyarat skema (mis. template yang diawali variabel). */
export function wrapUri(backend: string, uri: string): string | null {
  const m = ORIGINAL.exec(uri);
  if (!m) return null;
  const [, scheme, slashes, rest] = m;
  // Sisa yang diawali "@" digandakan agar tidak tertukar dengan penanda "@opaque/".
  const encoded = slashes ? (rest.startsWith("@") ? `@${rest}` : rest) : `${OPAQUE}${rest}`;
  return `${scheme}://${backend}/${encoded}`;
}

/** Balikkan URI gateway ke (nama backend, URI asli). null bila bentuknya tidak dikenali. */
export function unwrapUri(wrapped: string): { backend: string; uri: string } | null {
  const m = WRAPPED.exec(wrapped);
  if (!m) return null;
  const [, scheme, backend, encoded = ""] = m;
  if (encoded.startsWith(OPAQUE)) return { backend, uri: `${scheme}:${encoded.slice(OPAQUE.length)}` };
  return { backend, uri: `${scheme}://${encoded.startsWith("@") ? encoded.slice(1) : encoded}` };
}

type Meta = Record<string, unknown>;

/**
 * Tulis ulang penunjuk UI di `_meta` tool (MCP Apps): `_meta.ui.resourceUri`
 * dan bentuk lama `_meta["ui/resourceUri"]`. Tool tanpa penunjuk dikembalikan apa adanya.
 */
export function rewriteToolMeta<T extends { _meta?: Meta }>(backend: string, tool: T): T {
  const meta = tool._meta;
  if (!meta) return tool;
  let out: Meta = meta;

  const ui = meta.ui as Meta | undefined;
  if (ui && typeof ui === "object" && typeof ui.resourceUri === "string") {
    const w = wrapUri(backend, ui.resourceUri);
    if (w) out = { ...out, ui: { ...ui, resourceUri: w } };
  }
  const flat = meta["ui/resourceUri"];
  if (typeof flat === "string") {
    const w = wrapUri(backend, flat);
    if (w) out = { ...out, "ui/resourceUri": w };
  }
  return out === meta ? tool : { ...tool, _meta: out };
}

/**
 * Tulis ulang URI di satu blok konten (hasil tool atau pesan prompt):
 * `resource_link` membawa `uri`, `resource` (tertanam) membawa `resource.uri`.
 */
export function rewriteBlockUris<T>(backend: string, block: T): T {
  const b = block as { type?: string; uri?: unknown; resource?: { uri?: unknown } } | null;
  if (!b || typeof b !== "object") return block;
  if (b.type === "resource_link" && typeof b.uri === "string") {
    return { ...b, uri: wrapUri(backend, b.uri) ?? b.uri } as T;
  }
  if (b.type === "resource" && b.resource && typeof b.resource.uri === "string") {
    return { ...b, resource: { ...b.resource, uri: wrapUri(backend, b.resource.uri) ?? b.resource.uri } } as T;
  }
  return block;
}
