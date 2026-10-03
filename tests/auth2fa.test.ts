import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { login, totpSetup, totpEnable, totpDisable, createUser, updateUser, listUsers } from '../src/beleta/auth.js';
import { base32, base32Decode, totpAt, stepOf, verifyTotp } from '../src/beleta/totp.js';
import { makeApp } from './helpers.js';

describe('TOTP', () => {
  test('RFC 6238 testovací vektor (SHA1, T=59 → 94287082 → 287082)', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 1)).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
    expect(verifyTotp(secret, '287082', 59_000, 1)).toBeNull(); // replay
    expect(verifyTotp(secret, '287082', 200_000)).toBeNull();   // mimo toleranci
    expect(verifyTotp(secret, 'abc', 59_000)).toBeNull();
  });
});

async function setup2fa() {
  const app = await makeApp();
  const uid = (await app.db.query<any>(`select id from admin_users where email='admin@test.cz'`))[0].id as string;
  const { secret } = await totpSetup(app.db, uid);
  const now = Date.now();
  const recovery = await totpEnable(app.db, uid, totpAt(secret, stepOf(now)), now);
  return { app, uid, secret, recovery };
}

describe('2FA přihlášení', () => {
  test('bez kódu totp_required, se špatným kódem chyba, s platným kódem OK, replay a záložní kód jednorázově', async () => {
    const { app, secret, recovery } = await setup2fa();
    await expect(login(app.db, 'admin@test.cz', 'test-password-123')).rejects.toMatchObject({ code: 'totp_required' });
    await expect(login(app.db, 'admin@test.cz', 'spatne-heslo-12345', 8, '000000')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(login(app.db, 'admin@test.cz', 'test-password-123', 8, '000000')).rejects.toMatchObject({ code: 'invalid_credentials' });
    // krok po kroku použitém při zapnutí: následující krok je platný, opakování téhož ne
    const next = totpAt(secret, stepOf(Date.now()) + 1);
    await login(app.db, 'admin@test.cz', 'test-password-123', 8, next);
    await expect(login(app.db, 'admin@test.cz', 'test-password-123', 8, next)).rejects.toThrow();
    await login(app.db, 'admin@test.cz', 'test-password-123', 8, recovery[0]);
    await expect(login(app.db, 'admin@test.cz', 'test-password-123', 8, recovery[0])).rejects.toThrow();
    await login(app.db, 'admin@test.cz', 'test-password-123', 8, recovery[1]);
  });
  test('vypnutí vyžaduje heslo i kód', async () => {
    const { app, uid, secret } = await setup2fa();
    await expect(totpDisable(app.db, uid, 'spatne-heslo-12345', totpAt(secret, stepOf(Date.now()) + 1))).rejects.toThrow();
    await totpDisable(app.db, uid, 'test-password-123', totpAt(secret, stepOf(Date.now()) + 1));
    await login(app.db, 'admin@test.cz', 'test-password-123');
  });
  test('enable se špatným kódem selže', async () => {
    const app = await makeApp();
    const uid = (await app.db.query<any>(`select id from admin_users limit 1`))[0].id;
    await totpSetup(app.db, uid);
    await expect(totpEnable(app.db, uid, '123456')).rejects.toMatchObject({ code: 'invalid_code' });
  });
});

describe('správa uživatelů', () => {
  test('vytvoření, změna role, deaktivace odhlásí, poslední admin a sebe nelze odebrat', async () => {
    const app = await makeApp();
    const adminId = (await app.db.query<any>(`select id from admin_users limit 1`))[0].id;
    const id = await createUser(app.db, { email: 'Obchod@Test.cz', role: 'sales', password: 'dlouhe-heslo-123' });
    await expect(createUser(app.db, { email: 'obchod@test.cz', role: 'sales', password: 'dlouhe-heslo-123' })).rejects.toMatchObject({ code: 'user_exists' });
    await expect(createUser(app.db, { email: 'x@test.cz', role: 'sales', password: 'kratke' })).rejects.toThrow();
    await login(app.db, 'obchod@test.cz', 'dlouhe-heslo-123');
    await updateUser(app.db, adminId, id, { active: false });
    expect((await app.db.query('select 1 from admin_sessions where user_id=$1', [id])).length).toBe(0);
    await expect(login(app.db, 'obchod@test.cz', 'dlouhe-heslo-123')).rejects.toThrow();
    await expect(updateUser(app.db, adminId, adminId, { role: 'sales' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateUser(app.db, id, adminId, { active: false })).rejects.toMatchObject({ code: 'forbidden' }); // poslední admin
    await updateUser(app.db, adminId, id, { role: 'admin', active: true });
    await updateUser(app.db, id, adminId, { role: 'viewer' }); // teď už je druhý admin
    expect((await listUsers(app.db)).length).toBe(2);
  });
  test('REST: jen admin; login s kódem; admin resetuje 2FA', async () => {
    const { app, uid, secret } = await setup2fa();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    const lg = (email: string, password: string, code?: string) => srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email, password, code } });
    const r1 = await lg('admin@test.cz', 'test-password-123'); expect(r1.statusCode).toBe(401); expect(r1.json().error.code).toBe('totp_required');
    const r2 = await lg('admin@test.cz', 'test-password-123', totpAt(secret, stepOf(Date.now()) + 1)); expect(r2.statusCode).toBe(200);
    const cookie = String(r2.headers['set-cookie']).split(';')[0];
    expect((await srv.inject({ url: '/api/admin/me', headers: { cookie } })).json().user.totp_enabled).toBe(true);
    const mk = await srv.inject({ method: 'POST', url: '/api/admin/ai-sales/users', headers: { ...H, cookie }, payload: { email: 'v@test.cz', role: 'viewer', password: 'dlouhe-heslo-123' } });
    expect(mk.statusCode).toBe(200);
    const vl = await lg('v@test.cz', 'dlouhe-heslo-123'); const vc = String(vl.headers['set-cookie']).split(';')[0];
    expect((await srv.inject({ url: '/api/admin/ai-sales/users', headers: { cookie: vc } })).statusCode).toBe(403);
    const un = await srv.inject({ method: 'PATCH', url: `/api/admin/ai-sales/users/${uid}`, headers: { ...H, cookie }, payload: { reset_2fa: true } });
    expect(un.statusCode).toBe(200); // reset 2FA je povolen i sobě; zneplatní relace
    expect((await srv.inject({ url: '/api/admin/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await lg('admin@test.cz', 'test-password-123')).statusCode).toBe(200);
    await srv.close();
  });
});
