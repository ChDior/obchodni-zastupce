import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError, type Db } from '../ai-core/index.js';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const exp = Buffer.from(hashHex, 'hex');
  return exp.length === h.length && timingSafeEqual(exp, h);
}
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const DUMMY = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

export interface AdminUser { id: string; email: string; name: string; role: 'admin' | 'sales' | 'viewer' }

export async function ensureAdmin(db: Db, email: string, password: string) {
  if (password.length < 12) throw new Error('ADMIN_PASSWORD musí mít alespoň 12 znaků');
  const ex = await db.query('select 1 from admin_users limit 1');
  if (ex.length) return false;
  await db.query(`insert into admin_users (email, name, role, password_hash) values (lower($1),'Administrátor','admin',$2)`, [email, await hashPassword(password)]);
  return true;
}

export async function login(db: Db, email: string, password: string, ttlHours = 8): Promise<{ token: string; user: AdminUser }> {
  const rows = await db.query<any>('select * from admin_users where lower(email)=lower($1) and active', [email]);
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? DUMMY); // konstantní čas i pro neexistující účet
  if (!rows.length || !ok) throw new DomainError('invalid_credentials', 'Nesprávný e-mail nebo heslo');
  const token = randomBytes(32).toString('hex');
  await db.query(`insert into admin_sessions (token_hash, user_id, expires_at) values ($1,$2, now() + ($3 || ' hours')::interval)`, [tokenHash(token), rows[0].id, String(ttlHours)]);
  await db.query(`delete from admin_sessions where expires_at < now()`);
  const u = rows[0];
  return { token, user: { id: u.id, email: u.email, name: u.name, role: u.role } };
}
export async function userForToken(db: Db, token: string | undefined): Promise<AdminUser | null> {
  if (!token || token.length !== 64) return null;
  const r = await db.query<any>(
    `select u.id, u.email, u.name, u.role from admin_sessions s join admin_users u on u.id=s.user_id
     where s.token_hash=$1 and s.expires_at > now() and u.active`, [tokenHash(token)]);
  return r[0] ?? null;
}
export async function logout(db: Db, token: string) { await db.query('delete from admin_sessions where token_hash=$1', [tokenHash(token)]); }

/** Reset hesla (CLI): změní heslo a zneplatní všechny aktivní relace uživatele. */
export async function resetPassword(db: Db, email: string, password: string): Promise<boolean> {
  if (password.length < 12) throw new Error('Heslo musí mít alespoň 12 znaků');
  const r = await db.query<any>(`update admin_users set password_hash=$2, active=true where lower(email)=lower($1) returning id`, [email, await hashPassword(password)]);
  if (!r.length) return false;
  await db.query('delete from admin_sessions where user_id=$1', [r[0].id]);
  return true;
}
