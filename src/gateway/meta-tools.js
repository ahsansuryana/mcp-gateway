/**
 * Definisi tool milik gateway sendiri.
 * META_TOOLS hanya ditampilkan bila ada backend dalam mode lazy; sengaja dibuat sesingkat mungkin.
 */
export function buildToolDefs(NAME) {
  const STATUS_TOOL = {
    name: NAME.status,
    description: "Status backend gateway (jumlah tool, mode) dan URL login OAuth bila perlu.",
    inputSchema: { type: "object", properties: {} },
  };

  const META_TOOLS = [
    {
      name: NAME.search,
      description: `Cari tool yang disembunyikan dari daftar utama. Lanjut dengan ${NAME.describe}, lalu ${NAME.call}.`,
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
      name: NAME.describe,
      description: "Ambil schema lengkap satu tool (nama lengkap dari hasil pencarian).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: NAME.call,
      description: "Jalankan tool tersembunyi: name = nama lengkap, arguments = objek sesuai schema.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name"],
      },
    },
  ];

  return { STATUS_TOOL, META_TOOLS };
}
