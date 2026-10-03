import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { deactivateDemo, importCsv, parseCsv } from '../src/beleta/import-csv.js';
import { makeApp, ok, run, newCustomer } from './helpers.js';

const by = 'system:test';
const PRODUCTS = `sku;name;description;category;unit;weight_kg;price_net;vat_rate;stock_qty;lead_time_days;attr_min_sklon_stupne
REAL-01;Taška "Alfa";Popis; s čárkou;krytina;ks;4,5;41,50;21;1000;10;22
`.replace('Popis; s čárkou', '"Popis; s čárkou"');

describe('parseCsv', () => {
  test('BOM, oddělovač ; i ,, uvozovky, víceřádkové buňky, CRLF', () => {
    expect(parseCsv('﻿a;b\r\n1;"x;y"\r\n')).toEqual([['a', 'b'], ['1', 'x;y']]);
    expect(parseCsv('a,b\n"1 ""q""","l1\nl2"\n')).toEqual([['a', 'b'], ['1 "q"', 'l1\nl2']]);
  });
});

describe('import CSV', () => {
  test('products: vytvoření, idempotence, změna ceny a skladu, výsledek vidí AI tools', async () => {
    const app = await makeApp();
    const r1 = await importCsv(app.db, app.core.audit, 'products', PRODUCTS, { by });
    expect(r1).toMatchObject({ applied: true, created: 1, errors: [] });
    const price: any = ok(await run(app, 'get_price', { product: 'REAL-01' }));
    expect(price.amount_net).toBe(41.5);
    const detail: any = ok(await run(app, 'get_product', { product: 'REAL-01' }));
    expect(JSON.stringify(detail)).toContain('"min_sklon_stupne":22');
    expect(await importCsv(app.db, app.core.audit, 'products', PRODUCTS, { by })).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const r3 = await importCsv(app.db, app.core.audit, 'products', PRODUCTS.replace('41,50', '45').replace(';1000;', ';900;'), { by });
    expect(r3).toMatchObject({ updated: 1 });
    expect((ok(await run(app, 'get_price', { product: 'REAL-01' })) as any).amount_net).toBe(45);
    expect((await app.db.query('select 1 from prices p join products x on x.id=p.product_id where x.sku=$1', ['REAL-01'])).length).toBe(1); // změna ve stejný den přepíše
    expect((await app.core.audit.verifyChain(app.db)).ok).toBe(true);
  });
  test('chyby = nic se nezapíše, hlásí čísla řádků; dry_run také nic nezapíše', async () => {
    const app = await makeApp();
    const bad = `sku,name,price_net\nA-1,Dobrý,10\nA-2,Špatný,abc\nA-3,,5\nA-4,Bez ceny,\n`;
    const r = await importCsv(app.db, app.core.audit, 'products', bad, { by });
    expect(r.applied).toBe(false); expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5]);
    expect((await app.db.query("select 1 from products where sku like 'A-%'")).length).toBe(0);
    const dry = await importCsv(app.db, app.core.audit, 'products', 'sku,name,price_net\nB-1,Ok,10\n', { by, dryRun: true });
    expect(dry).toMatchObject({ applied: false, created: 1, errors: [] });
    expect((await app.db.query("select 1 from products where sku='B-1'")).length).toBe(0);
    await expect(importCsv(app.db, app.core.audit, 'products', 'name\nx\n', { by })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(importCsv(app.db, app.core.audit, 'products', 'sku,name,price_net,foo\nx,y,1,2\n', { by })).rejects.toThrow(/Neznámé sloupce/);
  });
  test('calc_rules, accessory_rules, shipping: import a použití v kalkulaci', async () => {
    const app = await makeApp();
    await importCsv(app.db, app.core.audit, 'products', 'sku,name,price_net,unit\nM-1,Hlavní,100,ks\nM-2,Příslušenství,10,m\n', { by });
    expect((await importCsv(app.db, app.core.audit, 'calc_rules', 'sku,consumption_per_m2,waste_pct,pack_size,pack_label\nM-1,"2,5",0,10,bal\n', { by })).created).toBe(1);
    expect((await importCsv(app.db, app.core.audit, 'accessory_rules', 'sku,accessory_sku,basis,factor\nM-1,M-2,per_m2,3\n', { by })).created).toBe(1);
    const bad = await importCsv(app.db, app.core.audit, 'accessory_rules', 'sku,accessory_sku,basis,factor\nM-1,M-2,per_kg,3\nM-1,NENI,per_m2,1\n', { by });
    expect(bad.errors.length).toBe(2);
    await importCsv(app.db, app.core.audit, 'shipping_zones', 'prefix,zone\n,Z\n5,Y\n', { by });
    await importCsv(app.db, app.core.audit, 'shipping_rates', 'zone,max_weight_kg,price_net,label\nZ,5000,1000,Valník\nY,5000,700,Valník\n', { by });
    await importCsv(app.db, app.core.audit, 'shipping_rates', 'zone,max_weight_kg,price_net\nZ,9000,1500\n', { by }); // nahrazuje sazby zóny Z
    expect((await app.db.query("select 1 from shipping_rates where zone='Z'")).length).toBe(1);
    expect((await app.db.query("select 1 from shipping_rates where zone='Y'")).length).toBe(1);
    const calc: any = ok(await run(app, 'calculate_material', { product: 'M-1', area_m2: 100 }));
    expect(calc.order_qty).toBe(250);
  });
  test('deactivate-demo vypne DEMO produkty, nabídka na ně pak selže', async () => {
    const app = await makeApp();
    expect(await deactivateDemo(app.db, app.core.audit, by)).toBe(5);
    const c = await newCustomer(app);
    const r = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 1 }] });
    expect(r.status).not.toBe('ok');
  });
  test('REST: jen admin, dry_run, text/csv', async () => {
    const app = await makeApp();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin' };
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: { ...H, 'content-type': 'application/json' }, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    const post = (url: string, payload: string) => srv.inject({ method: 'POST', url, headers: { ...H, cookie, 'content-type': 'text/csv; charset=utf-8' }, payload });
    expect((await srv.inject({ method: 'POST', url: '/api/admin/ai-sales/import/products', headers: { ...H, 'content-type': 'text/csv' }, payload: 'x' })).statusCode).toBe(401);
    const dry = await post('/api/admin/ai-sales/import/products?dry_run=1', 'sku,name,price_net\nR-1,Rest,5\n');
    expect(dry.statusCode).toBe(200); expect(dry.json()).toMatchObject({ dry_run: true, applied: false, created: 1 });
    const real = await post('/api/admin/ai-sales/import/products', 'sku,name,price_net\nR-1,Rest,5\n'); expect(real.json().applied).toBe(true);
    expect((await post('/api/admin/ai-sales/import/hacks', 'x')).statusCode).toBe(400);
    await srv.close();
  });
});
