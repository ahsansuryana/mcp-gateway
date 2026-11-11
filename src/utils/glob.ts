/** Glob sederhana: `*` = sembarang karakter. */
export const globMatch = (pattern: string, s: string): boolean =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(s);
