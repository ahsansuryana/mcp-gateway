import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolNames {
  status: string;
  search: string;
  describe: string;
  call: string;
}

export const buildToolNames = (sep: string): ToolNames => ({
  status: `gateway${sep}status`,
  search: `gateway${sep}search_tools`,
  describe: `gateway${sep}describe_tool`,
  call: `gateway${sep}call_tool`,
});

export const buildStatusTool = (names: ToolNames): Tool => ({
  name: names.status,
  description: "Status backend gateway (jumlah tool, mode) dan URL login OAuth bila perlu.",
  inputSchema: { type: "object", properties: {} },
});

/** Hanya ditampilkan bila ada backend dalam mode lazy. Sengaja dibuat sesingkat mungkin. */
export const buildMetaTools = (names: ToolNames): Tool[] => [
  {
    name: names.search,
    description: `Cari tool yang disembunyikan dari daftar utama. Lanjut dengan ${names.describe}, lalu ${names.call}.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "kata kunci, mis. 'deployment logs'" },
        server: { type: "string", description: "batasi ke satu server" },
        limit: { type: "integer", description: "maks hasil (default 10)" },
      },
    },
  },
  {
    name: names.describe,
    description: "Ambil schema lengkap satu tool (nama lengkap dari hasil pencarian).",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: names.call,
    description: "Jalankan tool tersembunyi: name = nama lengkap, arguments = objek sesuai schema.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object" } },
      required: ["name"],
    },
  },
];
