/**
 * Konteks bersama untuk seluruh modul gateway: config yang sudah diturunkan + pool backend.
 * Menggantikan variabel closure di versi lama.
 */
export function createContext(cfg, pool) {
  const sep = cfg.separator;
  const compactCfg = cfg.compact ?? null; // ada blok "compact" = pemadatan aktif
  const maxDesc = compactCfg?.max_description ?? 0; // 0 = tidak dipotong

  return {
    cfg,
    pool,
    sep,
    timeoutMs: (cfg.server.call_timeout ?? 60) * 1000,
    lazyThreshold: cfg.server.lazy_threshold ?? 40,
    compactCfg,
    maxDesc,
    searchDesc: maxDesc, // 0 = deskripsi utuh
    NAME: {
      status: `gateway${sep}status`,
      search: `gateway${sep}search_tools`,
      describe: `gateway${sep}describe_tool`,
      call: `gateway${sep}call_tool`,
    },
  };
}
