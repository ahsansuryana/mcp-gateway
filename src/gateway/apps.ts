/**
 * MCP Apps (SEP-1865): antarmuka interaktif yang dikirim server sebagai resource `ui://` HTML.
 * Identitas ekstensi dan MIME type mengikuti spesifikasi ext-apps.
 */

/** Kunci di `capabilities.extensions` untuk client maupun server. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

/** MIME type resource HTML MCP App. Client yang mendukung Apps wajib mencantumkannya. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

type Meta = Record<string, unknown>;

/**
 * Apakah tool membawa metadata UI: `_meta.ui` (resourceUri dan/atau visibility)
 * atau bentuk lama `_meta["ui/resourceUri"]`. Tool khusus-aplikasi (`visibility: ["app"]`)
 * juga terhitung karena UI-nya perlu bisa memanggil tool itu lewat host.
 */
export function hasUiMeta(tool: { _meta?: Meta }): boolean {
  const m = tool._meta;
  if (!m) return false;
  return (typeof m.ui === "object" && m.ui !== null) || typeof m["ui/resourceUri"] === "string";
}
