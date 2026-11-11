// glob sederhana: * = sembarang karakter
export const globMatch = (pattern, s) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(s);
