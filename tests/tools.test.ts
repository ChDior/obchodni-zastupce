import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Beleta } from '../src/beleta/bootstrap.js';
import { makeApp, ok, pub, run, sku } from './helpers.js';

let app: Beleta;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('1. vyhledání produktu', () => {
  test('najde produkt bez diakritiky a s českou koncovkou', async () => {
    const d = ok(await run(app, 'search_products', { query: 'betonovou tasku klasik' }));
    expect(d.products.map((p: any) => p.sku)).toContain('DEMO-TASKA-01');
  });
  test('filtr kategorie + limit', async () => {
    const d = ok(await run(app, 'search_products', { category: 'prislusenstvi', limit: 2 }));
    expect(d.products.length).toBe(2);
  });
  test('prázdný výsledek není chyba', async () => {
    expect(ok(await run(app, 'search_products', { query: 'raketoplan' })).count).toBe(0);
  });
  test('SQL wildcard/injection se bere jako text', async () => {
    const d = ok(await run(app, 'search_products', { query: "%'; drop table products;--" }));
    expect(d.count).toBe(0);
    expect(ok(await run(app, 'search_products', { query: 'klasik' })).count).toBe(1);
  });
  test('get_product vrací technické parametry z DB a zdroj', async () => {
    const r = await run(app, 'get_product', { product: 'demo-taska-01' });
    expect(ok(r).attributes.min_sklon_stupne).toBe(22);
    expect(r.status === 'ok' && r.sources[0].system).toBe('catalog');
  });
  test('neexistující produkt -> product_not_found', async () => {
    const r = await run(app, 'get_product', { product: 'NEEXISTUJE' });
    expect(r).toMatchObject({ status: 'error', error: { code: 'product_not_found' } });
  });
});

describe('2. cena', () => {
  test('cena bez/s DPH ze zdroje pricing', async () => {
    const r = await run(app, 'get_price', { product: 'DEMO-TASKA-01' });
    const d = ok(r);
    expect(d.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(d.amount_net).toBe(38); expect(d.amount_gross).toBe(45.98); expect(d.currency).toBe('CZK');
    expect(r.status === 'ok' && r.sources[0].system).toBe('pricing');
  });
  test('změna ceny v DB se okamžitě projeví (žádné hardcoded ceny)', async () => {
    const id = await sku(app, 'DEMO-SPONA-01');
    await app.db.query('update prices set amount_net=9.9 where product_id=$1', [id]);
    expect(ok(await run(app, 'get_price', { product: 'DEMO-SPONA-01' })).amount_net).toBe(9.9);
    await app.db.query('update prices set amount_net=4.5 where product_id=$1', [id]);
  });
  test('produkt bez platné ceny -> price_not_found (AI cenu nesmí odhadnout)', async () => {
    const id = await sku(app, 'DEMO-FOLIE-01');
    await app.db.query(`update prices set valid_to = current_date - 1 where product_id=$1`, [id]);
    expect(await run(app, 'get_price', { product: 'DEMO-FOLIE-01' })).toMatchObject({ status: 'error', error: { code: 'price_not_found' } });
    await app.db.query('update prices set valid_to = null where product_id=$1', [id]);
  });
  test('neplatná price_list/vstup -> validation_error', async () => {
    expect(await run(app, 'get_price', {})).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
  });
});

describe('3. sklad', () => {
  test('skladem', async () => {
    const d = ok(await run(app, 'check_stock', { product: 'DEMO-TASKA-01', qty: 1200 }));
    expect(d.in_stock).toBe(true); expect(d.earliest_dispatch_date).toBe('2026-10-02'); expect(d.shortfall).toBe(0);
  });
  test('není skladem -> chybějící množství a termín dle dodací lhůty', async () => {
    const d = ok(await run(app, 'check_stock', { product: 'DEMO-TASKA-02', qty: 100 }));
    expect(d.in_stock).toBe(false); expect(d.shortfall).toBe(100); expect(d.earliest_dispatch_date).toBe('2026-10-30');
  });
  test('rezervované zásoby se odečítají', async () => {
    const id = await sku(app, 'DEMO-LATE-01');
    await app.db.query('update stock set qty_reserved=4900 where product_id=$1', [id]);
    expect(ok(await run(app, 'check_stock', { product: 'DEMO-LATE-01', qty: 200 })).in_stock).toBe(false);
    await app.db.query('update stock set qty_reserved=0 where product_id=$1', [id]);
  });
  test('chybějící data o skladu -> stock_unknown', async () => {
    const id = await sku(app, 'DEMO-SPONA-01');
    await app.db.query('delete from stock where product_id=$1', [id]);
    expect(await run(app, 'check_stock', { product: 'DEMO-SPONA-01', qty: 1 })).toMatchObject({ status: 'error', error: { code: 'stock_unknown' } });
    await app.db.query(`insert into stock (product_id, qty_available, lead_time_days) values ($1, 50000, 7)`, [id]);
  });
});

describe('4./5. kalkulace materiálu', () => {
  test('100 m²', async () => {
    const d = ok(await run(app, 'calculate_material', { product: 'DEMO-TASKA-01', area_m2: 100 }));
    expect(d.required_qty).toBe(1050); expect(d.packs).toBe(4); expect(d.order_qty).toBe(1200);
    expect(d.line_net).toBe(45600); expect(d.total_weight_kg).toBe(5160);
  });
  test('250 m²', async () => {
    const d = ok(await run(app, 'calculate_material', { product: 'DEMO-TASKA-01', area_m2: 250 }));
    expect(d.required_qty).toBe(2625); expect(d.packs).toBe(9); expect(d.order_qty).toBe(2700); expect(d.line_net).toBe(102600);
  });
  test('pravidla se berou z DB (změna waste_pct mění výsledek)', async () => {
    const id = await sku(app, 'DEMO-TASKA-01');
    await app.db.query('update calc_rules set waste_pct=0 where product_id=$1', [id]);
    expect(ok(await run(app, 'calculate_material', { product: 'DEMO-TASKA-01', area_m2: 100 })).required_qty).toBe(1000);
    await app.db.query('update calc_rules set waste_pct=5 where product_id=$1', [id]);
  });
  test('chyby: záporná/nulová/obří plocha, produkt bez pravidel', async () => {
    for (const area of [0, -5, 1e9]) expect(await run(app, 'calculate_material', { product: 'DEMO-TASKA-01', area_m2: area })).toMatchObject({ error: { code: 'validation_error' } });
    expect(await run(app, 'calculate_material', { product: 'DEMO-LATE-01', area_m2: 10 })).toMatchObject({ error: { code: 'no_calc_rule' } });
  });
  test('příslušenství pro 100 m²', async () => {
    const d = ok(await run(app, 'calculate_accessories', { product: 'DEMO-TASKA-01', area_m2: 100, quantity: 1200 }));
    const by = Object.fromEntries(d.items.map((i: any) => [i.product.sku, i.order_qty]));
    expect(by).toEqual({ 'DEMO-LATE-01': 336, 'DEMO-FOLIE-01': 115, 'DEMO-SPONA-01': 1224 });
  });
  test('příslušenství bez potřebného vstupu -> missing_input', async () => {
    expect(await run(app, 'calculate_accessories', { product: 'DEMO-TASKA-01', area_m2: 100 })).toMatchObject({ error: { code: 'missing_input' } });
    expect(await run(app, 'calculate_accessories', { product: 'DEMO-TASKA-01' })).toMatchObject({ error: { code: 'validation_error' } });
  });
  test('doprava: zóna dle PSČ a pásmo dle hmotnosti', async () => {
    const praha = ok(await run(app, 'calculate_shipping', { items: [{ product: 'DEMO-TASKA-01', qty: 1200 }], postal_code: '110 00' }));
    expect(praha.zone).toBe('A'); expect(praha.price_net).toBe(4500); expect(praha.total_weight_kg).toBe(5160);
    const brno = ok(await run(app, 'calculate_shipping', { items: [{ product: 'DEMO-TASKA-01', qty: 100 }], postal_code: '60200' }));
    expect(brno.zone).toBe('B'); expect(brno.price_net).toBe(3200);
    const big = ok(await run(app, 'calculate_shipping', { items: [{ product: 'DEMO-TASKA-01', qty: 5000 }], postal_code: '60200' }));
    expect(big.vehicles).toBe(2); expect(big.price_net).toBe(11800);
  });
  test('doprava: neplatné PSČ', async () => {
    expect(await run(app, 'calculate_shipping', { items: [{ product: 'DEMO-TASKA-01', qty: 1 }], postal_code: 'ABC' })).toMatchObject({ error: { code: 'validation_error' } });
  });
});

describe('autorizace (scopes)', () => {
  test('veřejný aktér smí číst katalog, ale ne zapisovat do CRM', async () => {
    ok(await run(app, 'get_price', { product: 'DEMO-TASKA-01' }, pub));
    expect(await run(app, 'create_customer', { name: 'Test Test', email: 'a@b.cz' }, pub)).toMatchObject({ status: 'error', error: { code: 'forbidden' } });
    expect(await run(app, 'send_email', {}, pub)).toMatchObject({ error: { code: 'validation_error' } }); // validace předchází, ale scope se ověří při platném vstupu
  });
  test('neznámý nástroj', async () => {
    expect(await run(app, 'drop_database', {})).toMatchObject({ error: { code: 'unknown_tool' } });
  });
});

describe('znalostní báze', () => {
  test('najde relevantní pasáž a uvede zdroj', async () => {
    const r = await run(app, 'search_knowledge', { query: 'jaký je postup při montáži krytiny a zajištění tašek' });
    const d = ok(r);
    expect(d.count).toBeGreaterThan(0);
    expect(d.passages[0].title).toContain('Montáž');
    expect(r.status === 'ok' && r.sources[0].system).toBe('knowledge_base');
  });
  test('nic nenalezeno -> prázdný výsledek', async () => {
    expect(ok(await run(app, 'search_knowledge', { query: 'xyzzyx qwertz' })).count).toBe(0);
  });
});
