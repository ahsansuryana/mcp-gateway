const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
