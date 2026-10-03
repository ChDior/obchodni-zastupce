import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError, type Db } from '../ai-core/index.js';
import { newSecret, otpauthUri, stepOf, verifyTotp } from './totp.js';

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
const recoveryHash = (c: string) => createHash('sha256').update('recovery:' + c.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
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

export async function login(db: Db, email: string, password: string, ttlHours = 8, code?: string): Promise<{ token: string; user: AdminUser }> {
  const rows = await db.query<any>('select * from admin_users where lower(email)=lower($1) and active', [email]);
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? DUMMY); // konstantní čas i pro neexistující účet
  if (!rows.length || !ok) throw new DomainError('invalid_credentials', 'Nesprávný e-mail nebo heslo');
  const u = rows[0];
  if (u.totp_enabled) {
    if (!code) throw new DomainError('totp_required', 'Zadejte ověřovací kód');
    if (!(await consumeSecondFactor(db, u, code.trim()))) throw new DomainError('invalid_credentials', 'Neplatný ověřovací kód');
  }
  const token = randomBytes(32).toString('hex');
  await db.query(`insert into admin_sessions (token_hash, user_id, expires_at) values ($1,$2, now() + ($3 || ' hours')::interval)`, [tokenHash(token), rows[0].id, String(ttlHours)]);
  await db.query(`delete from admin_sessions where expires_at < now()`);
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

/** Reset hesla (CLI): změní heslo, vypne 2FA a zneplatní všechny aktivní relace uživatele. */
export async function resetPassword(db: Db, email: string, password: string): Promise<boolean> {
  if (password.length < 12) throw new Error('Heslo musí mít alespoň 12 znaků');
  const r = await db.query<any>(`update admin_users set password_hash=$2, active=true, totp_enabled=false, totp_secret=null, totp_last_step=null, recovery_hashes='[]'::jsonb where lower(email)=lower($1) returning id`, [email, await hashPassword(password)]);
  if (!r.length) return false;
  await db.query('delete from admin_sessions where user_id=$1', [r[0].id]);
  return true;
}

/** TOTP kód (jednou za krok) nebo záložní kód (jednorázový). */
async function consumeSecondFactor(db: Db, u: any, code: string, now = Date.now()): Promise<boolean> {
  if (u.totp_secret) {
    const step = verifyTotp(u.totp_secret, code, now, u.totp_last_step == null ? null : Number(u.totp_last_step));
    if (step != null) {
      const r = await db.query(`update admin_users set totp_last_step=$2 where id=$1 and (totp_last_step is null or totp_last_step < $2) returning id`, [u.id, step]);
      return r.length > 0;
    }
  }
  const h = recoveryHash(code);
  const list: string[] = u.recovery_hashes ?? [];
  if (!list.includes(h)) return false;
  const r = await db.query(`update admin_users set recovery_hashes = recovery_hashes - $2::text where id=$1 and recovery_hashes ? $2::text returning id`, [u.id, h]);
  return r.length > 0;
}

export async function totpSetup(db: Db, userId: string) {
  const u = (await db.query<any>('select email, totp_enabled from admin_users where id=$1', [userId]))[0];
  if (u.totp_enabled) throw new DomainError('totp_already_enabled', '2FA už je zapnuté');
  const secret = newSecret();
  await db.query('update admin_users set totp_secret=$2 where id=$1', [userId, secret]);
  return { secret, otpauth_uri: otpauthUri(secret, u.email) };
}

export async function totpEnable(db: Db, userId: string, code: string, now = Date.now()): Promise<string[]> {
  const u = (await db.query<any>('select * from admin_users where id=$1', [userId]))[0];
  if (u.totp_enabled) throw new DomainError('totp_already_enabled', '2FA už je zapnuté');
  const step = u.totp_secret ? verifyTotp(u.totp_secret, code.trim(), now) : null;
  if (step == null) throw new DomainError('invalid_code', 'Neplatný ověřovací kód');
  const codes = Array.from({ length: 8 }, () => { const r = randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
  await db.query('update admin_users set totp_enabled=true, totp_last_step=$2, recovery_hashes=$3::jsonb where id=$1', [userId, step, JSON.stringify(codes.map(recoveryHash))]);
  return codes;
}

export async function totpDisable(db: Db, userId: string, password: string, code: string) {
  const u = (await db.query<any>('select * from admin_users where id=$1', [userId]))[0];
  if (!u.totp_enabled) throw new DomainError('totp_not_enabled', '2FA není zapnuté');
  if (!(await verifyPassword(password, u.password_hash)) || !(await consumeSecondFactor(db, u, code.trim()))) throw new DomainError('invalid_credentials', 'Nesprávné heslo nebo kód');
  await db.query(`update admin_users set totp_enabled=false, totp_secret=null, totp_last_step=null, recovery_hashes='[]'::jsonb where id=$1`, [userId]);
}

export async function totpEnabledFor(db: Db, userId: string): Promise<boolean> {
  return !!(await db.query<any>('select totp_enabled from admin_users where id=$1', [userId]))[0]?.totp_enabled;
}

/* ---------- správa uživatelů (admin) ---------- */
type Role = AdminUser['role'];
export async function listUsers(db: Db) {
  return db.query(`select id, email, name, role, active, totp_enabled, created_at from admin_users order by created_at`);
}
async function activeAdmins(t: Db, exceptId?: string) {
  return (await t.query<any>(`select id from admin_users where role='admin' and active ${exceptId ? 'and id <> $1::uuid' : ''}`, exceptId ? [exceptId] : [])).length;
}
export async function createUser(db: Db, i: { email: string; name?: string; role: Role; password: string }) {
  if (i.password.length < 12) throw new DomainError('validation_error', 'Heslo musí mít alespoň 12 znaků');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.email)) throw new DomainError('validation_error', 'Neplatný e-mail');
  if (await db.query('select 1 from admin_users where lower(email)=lower($1)', [i.email]).then((r) => r.length)) throw new DomainError('user_exists', 'Uživatel s tímto e-mailem už existuje');
  const r = await db.query<any>(`insert into admin_users (email, name, role, password_hash) values (lower($1),$2,$3,$4) returning id`, [i.email, i.name ?? '', i.role, await hashPassword(i.password)]);
  return r[0].id as string;
}
/** Změna role / aktivity / hesla / vypnutí 2FA. Nelze odebrat posledního aktivního admina ani zablokovat sebe. */
export async function updateUser(db: Db, actorId: string, id: string, p: { role?: Role; active?: boolean; password?: string; reset_2fa?: boolean; name?: string }) {
  await db.tx(async (t) => {
    const u = (await t.query<any>('select * from admin_users where id=$1 for update', [id]))[0];
    if (!u) throw new DomainError('not_found', 'Uživatel neexistuje');
    const role = p.role ?? u.role, active = p.active ?? u.active;
    if (id === actorId && (role !== 'admin' || !active)) throw new DomainError('forbidden', 'Nelze odebrat práva ani deaktivovat sám sebe');
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && (await activeAdmins(t, id)) === 0) throw new DomainError('forbidden', 'Musí zůstat alespoň jeden aktivní administrátor');
    if (p.password !== undefined && p.password.length < 12) throw new DomainError('validation_error', 'Heslo musí mít alespoň 12 znaků');
    await t.query('update admin_users set role=$2, active=$3, name=$4 where id=$1', [id, role, active, p.name ?? u.name]);
    if (p.password !== undefined) await t.query('update admin_users set password_hash=$2 where id=$1', [id, await hashPassword(p.password)]);
    if (p.reset_2fa) await t.query(`update admin_users set totp_enabled=false, totp_secret=null, totp_last_step=null, recovery_hashes='[]'::jsonb where id=$1`, [id]);
    if (p.password !== undefined || !active || role !== u.role || p.reset_2fa) await t.query('delete from admin_sessions where user_id=$1', [id]);
  });
}
