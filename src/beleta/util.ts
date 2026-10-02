export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
export const num = (v: unknown) => (v == null ? 0 : Number(v));
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(d: Date, days: number) { return new Date(d.getTime() + days * 86_400_000); }
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sloupce typu date vrací driver jako Date (UTC půlnoc) nebo string – sjednotíme na YYYY-MM-DD. */
export const dateStr = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
