import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { makeApp, ok, run } from './helpers.js';

async function setup() {
  const app = await makeApp();
  const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
  const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
  const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
  const cookie = String(l.headers['set-cookie']).split(';')[0];
  const call = (method: string, url: string, payload?: unknown, c = cookie) => srv.inject({ method: method as any, url: `/api/admin/ai-sales${url}`, headers: { ...H, cookie: c }, payload: payload as any });
  return { app, srv, call, H, cookie };
}

describe('editace katalogu v administraci', () => {
  test('seznam, hledání bez diakritiky, detail', async () => {
    const { srv, call } = await setup();
    const list = (await call('GET', '/products?q=TASKA')).json();
    expect(list.map((p: any) => p.sku)).toContain('DEMO-TASKA-01');
    expect(list.find((p: any) => p.sku === 'DEMO-TASKA-01')).toMatchObject({ price_net: 38, active: true });
    const d = (await call('GET', `/products/${list[0].id}`)).json();
    expect(d.product.sku).toBeTruthy(); expect(d.prices.length).toBeGreaterThan(0);
    expect((await call('GET', '/products/not-uuid')).statusCode).toBe(400);
    await srv.close();
  });
  test('změna ceny a skladu se okamžitě projeví v AI nástrojích a jde do auditu', async () => {
    const { app, srv, call } = await setup();
    const id = (await app.db.query<any>(`select id from products where sku='DEMO-TASKA-01'`))[0].id;
    const r = await call('PATCH', `/products/${id}`, { price_net: 44.5, stock_qty: 10, lead_time_days: 3, name: 'Nový název' });
    expect(r.statusCode).toBe(200);
    expect((ok(await run(app, 'get_price', { product: 'DEMO-TASKA-01' })) as any).amount_net).toBe(44.5);
    expect((ok(await run(app, 'check_stock', { product: 'DEMO-TASKA-01', qty: 11 })) as any).in_stock).toBe(false);
    const act = await app.db.query<any>(`select output from ai_audit_log where action='catalog.update'`);
    expect(act.length).toBe(1); expect(act[0].output).toMatchObject({ sku: 'DEMO-TASKA-01', price_net: 44.5 });
    expect((await app.core.audit.verifyChain(app.db)).ok).toBe(true);
    await srv.close();
  });
  test('nový produkt vyžaduje cenu a unikátní SKU; deaktivace skryje z vyhledávání; kalkulační pravidlo a parametry', async () => {
    const { app, srv, call } = await setup();
    expect((await call('POST', '/products', { sku: 'N-1', name: 'Bez ceny' })).statusCode).toBe(400);
    const c = await call('POST', '/products', { sku: 'N-1', name: 'Nový produkt', unit: 'ks', price_net: 10, stock_qty: 5, attributes: { barva: 'červená', sklon: 22 }, calc_rule: { consumption_per_m2: 2, pack_size: 5, pack_label: 'bal' } });
    expect(c.statusCode).toBe(200);
    expect((await call('POST', '/products', { sku: 'N-1', name: 'Dup', price_net: 1 })).statusCode).toBe(409);
    const id = c.json().id;
    const d = (await call('GET', `/products/${id}`)).json();
    expect(d.product.attributes).toEqual({ barva: 'červená', sklon: 22 }); expect(d.calc_rule).toMatchObject({ consumption_per_m2: 2, pack_size: 5 });
    expect((ok(await run(app, 'calculate_material', { product: 'N-1', area_m2: 10 })) as any).order_qty).toBeGreaterThan(0);
    expect((await call('PATCH', `/products/${id}`, { sku: 'JINE' })).statusCode).toBe(400);
    expect((await call('PATCH', `/products/${id}`, { price_net: -5 })).statusCode).toBe(400);
    expect((await call('PATCH', `/products/${id}`, { bogus: 1 })).statusCode).toBe(400);
    await call('PATCH', `/products/${id}`, { active: false });
    expect(((ok(await run(app, 'search_products', { query: 'Nový produkt' })) as any).products as any[]).some((p) => p.sku === 'N-1')).toBe(false);
    await srv.close();
  });
  test('jen admin smí měnit; nepřihlášený nic', async () => {
    const { app, srv, call, H } = await setup();
    const { createUser } = await import('../src/beleta/auth.js');
    await createUser(app.db, { email: 'sales@test.cz', role: 'sales', password: 'dlouhe-heslo-123' });
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'sales@test.cz', password: 'dlouhe-heslo-123' } });
    const sc = String(l.headers['set-cookie']).split(';')[0];
    expect((await call('GET', '/products', undefined, sc)).statusCode).toBe(200);
    expect((await call('POST', '/products', { sku: 'X', name: 'x', price_net: 1 }, sc)).statusCode).toBe(403);
    expect((await srv.inject('/api/admin/ai-sales/products')).statusCode).toBe(401);
    await srv.close();
  });
});
