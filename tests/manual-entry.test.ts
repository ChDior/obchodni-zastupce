import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { createUser } from '../src/beleta/auth.js';
import { makeApp, ok, run } from './helpers.js';

async function setup() {
  const app = await makeApp();
  const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
  const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
  const login = async (e: string, p: string) => String((await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: e, password: p } })).headers['set-cookie']).split(';')[0];
  const cookie = await login('admin@test.cz', 'test-password-123');
  const api = (m: string, u: string, payload?: unknown, c = cookie) => srv.inject({ method: m as any, url: `/api/admin/ai-sales${u}`, headers: { ...H, cookie: c }, payload: payload as any });
  return { app, srv, api, login };
}

describe('ruční zadávání v administraci', () => {
  test('zákazník → poptávka → projekt → nabídka (ceny z DB) → úprava projektu; vše v auditu jako člověk', async () => {
    const { app, srv, api } = await setup();
    const c = await api('POST', '/customers', { type: 'company', name: 'Stavby Novák s.r.o.', ico: '12345678', email: 'info@stavby-novak.cz', phone: '+420 777 111 222', postal_code: '602 00' });
    expect(c.statusCode).toBe(200); const cid = c.json().data.customer_id;
    const l = await api('POST', '/leads', { customer_id: cid, summary: 'Telefonická poptávka na fasádu', source: 'phone', qualification: { project_type: 'fasada', area_m2: 180 } });
    expect(l.statusCode).toBe(200); expect(l.json().data.lead_id).toBeTruthy();
    const p = await api('POST', '/projects', { customer_id: cid, lead_id: l.json().data.lead_id, name: 'Fasáda bytového domu Brno', project_type: 'fasada', area_m2: 180, postal_code: '602 00' });
    expect(p.statusCode).toBe(200); const pid = p.json().data.project_id;
    const q = await api('POST', '/quotes', { customer_id: cid, project_id: pid, items: [{ product: 'DEMO-TASKA-01', qty: 50 }], shipping_postal_code: '602 00', discount_pct: 5, notes: 'Zadáno ručně' });
    expect(q.statusCode).toBe(200); expect(q.json().data.number).toMatch(/^N-\d{4}-\d{4}$/);
    const price = (ok(await run(app, 'get_price', { product: 'DEMO-TASKA-01' })) as any).amount_net;
    const row = (await app.db.query<any>('select subtotal_check, discount_pct, created_by from (select discount_pct, created_by, 1 as subtotal_check from quotes) t'))[0];
    expect(Number(row.discount_pct)).toBe(5); expect(row.created_by).toBe('human:admin@test.cz');
    const items = await app.db.query<any>('select unit_price_net from quote_items'); expect(Number(items[0].unit_price_net)).toBe(price); // cena z DB, ne od uživatele
    expect((await api('PATCH', `/projects/${pid}`, { status: 'negotiation', notes: 'Jednání' })).statusCode).toBe(200);
    expect((await app.db.query<any>('select status from projects'))[0].status).toBe('negotiation');
    const audit = (await app.db.query<any>(`select tool, actor_id from ai_audit_log where tool in ('create_customer','create_lead','create_project','create_quote','update_project')`));
    expect(audit.length).toBe(5); expect(audit.every((a) => a.actor_id === 'human:admin@test.cz')).toBe(true);
    await srv.close();
  });
  test('validace, neznámý produkt, neexistující zákazník, role viewer', async () => {
    const { app, srv, api, login } = await setup();
    expect((await api('POST', '/customers', { name: 'X' })).statusCode).toBe(400);
    expect((await api('POST', '/customers', { name: 'Jan Novák' })).statusCode).toBe(400); // chybí e-mail i telefon
    expect((await api('POST', '/customers', { name: 'Jan Novák', email: 'neni-email' })).statusCode).toBe(400);
    expect((await api('POST', '/customers', { name: 'Jan Novák', email: 'jan@example.cz', extra: 1 })).statusCode).toBe(400);
    const cid = (await api('POST', '/customers', { name: 'Jan Novák', email: 'jan@example.cz' })).json().data.customer_id;
    expect((await api('POST', '/quotes', { customer_id: cid, items: [{ product: 'NENI-TAKOVY', qty: 1 }] })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await api('POST', '/quotes', { customer_id: cid, items: [] })).statusCode).toBe(400);
    expect((await api('POST', '/quotes', { customer_id: crypto.randomUUID(), items: [{ product: 'DEMO-TASKA-01', qty: 1 }] })).statusCode).toBe(404);
    expect((await api('POST', '/projects', { customer_id: cid, name: 'ab' })).statusCode).toBe(400);
    await createUser(app.db, { email: 'viewer@test.cz', role: 'viewer', password: 'dlouhe-heslo-123' });
    const vc = await login('viewer@test.cz', 'dlouhe-heslo-123');
    for (const [u, b] of [['/customers', { name: 'Jan Nový', email: 'novy@example.cz' }], ['/leads', { customer_id: cid, summary: 'abc' }], ['/projects', { customer_id: cid, name: 'Projekt' }], ['/quotes', { customer_id: cid, items: [{ product: 'DEMO-TASKA-01', qty: 1 }] }]] as const) {
      expect((await api('POST', u, b, vc)).statusCode, u).toBe(403);
    }
    await srv.close();
  });
});
