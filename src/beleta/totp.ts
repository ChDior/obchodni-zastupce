import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(randomBytes(20));
export const STEP_SECONDS = 30;
export const stepOf = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** RFC 6238 (HMAC-SHA1, 6 číslic, krok 30 s). */
export function totpAt(secret: string, step: number): string {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Vrátí step, ve kterém kód platí (tolerance ±1 krok), jinak null. Volající musí step > poslední použitý (replay). */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepOf(nowMs);
  for (const s of [cur - 1, cur, cur + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    if (totpAt(secret, s) === code) return s;
  }
  return null;
}

export const otpauthUri = (secret: string, email: string, issuer = 'BELETA AI SALES') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
