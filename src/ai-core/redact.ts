const SENSITIVE_KEY = /(e-?mail|phone|telefon|tel$|password|heslo|token|secret|api[-_]?key|street|ulice|address|adresa|iban|^ico$|^dic$|to_email|body)/i;
const NAME_KEY = /^(name|customer_name|contact_name|company_name|jmeno|prijmeni)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w.])\+?\d[\d\s-]{7,}\d(?![\w.])/g;

function maskName(s: string): string {
  return s.split(/\s+/).map((p) => (p ? p[0] + '***' : p)).join(' ');
}

/** Odstraní/maskuje osobní a citlivé údaje, aby se nedostaly do logů a auditu. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    const s = value.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
    return s.length > 500 ? s.slice(0, 500) + '…[truncated]' : s;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) out[k] = v == null ? v : '[redacted]';
      else if (NAME_KEY.test(k) && typeof v === 'string') out[k] = maskName(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
