import { describe, expect, test } from 'vitest';
import { bootstrap } from '../src/beleta/bootstrap.js';
import { buildServer } from '../src/server/app.js';
import { eraseCustomer, exportCustomer, runRetention } from '../src/beleta/gdpr.js';
import { renderQuotePdf } from '../src/beleta/quote-pdf.js';
import { makeApp, newCustomer, ok, run, human } from './helpers.js';

async function withQuote() {
  const app = await makeApp();
  const c = await newCustomer(app);
  const q = ok<{ quote_id: string }>(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 10 }], shipping_postal_code: '11000' }));
  return { app, c, q: q.quote_id };
}

describe('PDF nabídky', () => {
  test('vykreslí platné PDF, neexistující nabídka = chyba', async () => {
    const { app, q } = await withQuote();
    const { filename, buffer } = await renderQuotePdf(app.db, app.core.policy, q);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(2000);
    expect(filename).toMatch(/\.pdf$/);
    await expect(renderQuotePdf(app.db, app.core.policy, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'quote_not_found' });
  });
  test('endpoint vyžaduje přihlášení a vrací application/pdf', async () => {
    const { app, q } = await withQuote();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    expect((await srv.inject(`/api/admin/ai-sales/quotes/${q}/pdf`)).statusCode).toBe(401);
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    const r = await srv.inject({ url: `/api/admin/ai-sales/quotes/${q}/pdf`, headers: { cookie } });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    await srv.close();
  });
});

describe('GDPR', () => {
  test('výmaz anonymizuje osobní údaje, zachová audit řetěz a zapíše záznam', async () => {
    const { app, c } = await withQuote();
    await app.db.query(`update customers set note='tajná poznámka' where id=$1`, [c]);
    await eraseCustomer(app.db, app.core.audit, c, human.id);
    const r = (await app.db.query<any>('select * from customers where id=$1', [c]))[0];
    expect(r).toMatchObject({ name: '[smazáno]', email: null, phone: null, note: null });
    expect(r.erased_at).toBeTruthy();
    expect((await app.db.query('select 1 from gdpr_erasures where customer_id=$1', [c])).length).toBe(1);
    expect((await app.core.audit.verifyChain(app.db)).ok).toBe(true);
    await expect(eraseCustomer(app.db, app.core.audit, c, human.id)).rejects.toMatchObject({ code: 'already_erased' });
    await expect(eraseCustomer(app.db, app.core.audit, '00000000-0000-0000-0000-000000000000', human.id)).rejects.toMatchObject({ code: 'customer_not_found' });
  });
  test('export obsahuje data zákazníka a auditní záznam', async () => {
    const { app, c } = await withQuote();
    const d: any = await exportCustomer(app.db, app.core.audit, c, human.id);
    expect(d.customer.email).toBe('jan.novak@example.cz');
    expect(d.quotes.length).toBe(1); expect(d.quotes[0].items.length).toBe(1);
    expect((await app.db.query("select 1 from ai_audit_log where action='gdpr.export'")).length).toBe(1);
  });
  test('retence anonymizuje jen neaktivní zákazníky bez souhlasu a bez otevřené nabídky', async () => {
    const app = await makeApp();
    const old = await newCustomer(app, 'stary@example.cz');
    const consent = await newCustomer(app, 'souhlas@example.cz');
    const fresh = await newCustomer(app, 'novy@example.cz');
    await app.db.query(`update customers set created_at='2020-01-01' where id in ($1,$2)`, [old, consent]);
    await app.db.query(`update customers set consent_marketing=true where id=$1`, [consent]);
    expect(await runRetention(app.db, app.core.audit, 0)).toEqual({ erased: 0, disabled: true });
    expect((await runRetention(app.db, app.core.audit, 36)).erased).toBe(1);
    const st = async (id: string) => (await app.db.query<any>('select erased_at from customers where id=$1', [id]))[0].erased_at;
    expect(await st(old)).toBeTruthy(); expect(await st(consent)).toBeNull(); expect(await st(fresh)).toBeNull();
  });
  test('REST: výmaz jen pro admina, retence jen s interním tokenem', async () => {
    const { app, c } = await withQuote();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', internalToken: 'internal-token-internal-token', secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin' };
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: { ...H, 'content-type': 'application/json' }, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    expect((await srv.inject({ method: 'POST', url: `/api/admin/ai-sales/customers/${c}/erase`, headers: H })).statusCode).toBe(401);
    expect((await srv.inject({ method: 'POST', url: `/api/admin/ai-sales/customers/${c}/erase`, headers: { ...H, cookie } })).statusCode).toBe(200);
    expect((await srv.inject({ method: 'POST', url: `/api/admin/ai-sales/customers/${c}/erase`, headers: { ...H, cookie } })).statusCode).toBe(409);
    expect((await srv.inject({ method: 'POST', url: '/api/internal/gdpr/retention' })).statusCode).toBe(401);
    expect((await srv.inject({ method: 'POST', url: '/api/internal/gdpr/retention', headers: { 'x-internal-token': 'internal-token-internal-token' } })).statusCode).toBe(200);
    await srv.close();
  });
});
void bootstrap;

describe('zákazníci v administraci', () => {
  test('seznam s hledáním a detail s navázanými záznamy', async () => {
    const { app, c } = await withQuote();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    expect((await srv.inject('/api/admin/ai-sales/customers')).statusCode).toBe(401);
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    const list = (await srv.inject({ url: '/api/admin/ai-sales/customers?q=NOVAK%25', headers: { cookie } })).json();
    expect(list.length).toBe(1); expect(list[0].quotes).toBe(1);
    expect((await srv.inject({ url: '/api/admin/ai-sales/customers?q=nikdo', headers: { cookie } })).json()).toEqual([]);
    const d = (await srv.inject({ url: `/api/admin/ai-sales/customers/${c}`, headers: { cookie } })).json();
    expect(d.customer.email).toBe('jan.novak@example.cz'); expect(d.quotes.length).toBe(1);
    expect((await srv.inject({ url: '/api/admin/ai-sales/customers/00000000-0000-0000-0000-000000000000', headers: { cookie } })).statusCode).toBe(404);
    await srv.close();
  });
});
