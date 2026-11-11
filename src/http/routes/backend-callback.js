import { log } from "../../utils/logger.js";
import { sendHtml } from "../io.js";

/**
 * Tujuan redirect browser setelah login di authorization server backend.
 * Tidak bisa memakai bearer token; dilindungi oleh parameter `state` acak.
 */
export async function handleBackendCallback(req, res, url, { pool }) {
  const name = pool.findByState(url.searchParams.get("state"));
  if (!name) return sendHtml(res, 400, "Login gagal", "State tidak valid atau sudah kedaluwarsa. Mulai ulang dari URL login terbaru.");
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err || !code) return sendHtml(res, 400, "Login ditolak", `Authorization server membalas: ${err ?? "tanpa code"}`);
  try {
    await pool.completeAuth(name, code);
    log("INFO", `login OAuth '${name}' berhasil`);
    return sendHtml(res, 200, "Login berhasil", `Backend '${name}' sudah terhubung. Tab ini boleh ditutup.`);
  } catch (e) {
    log("ERROR", `login OAuth '${name}' gagal:`, e?.message ?? e);
    return sendHtml(res, 500, "Login gagal", e?.message ?? String(e));
  }
}
