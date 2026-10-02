import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Beleta } from '../src/beleta/bootstrap.js';
import { makeApp, newCustomer, ok, run, sku } from './helpers.js';

let app: Beleta;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('6. vytvoření leadu', () => {
  test('vytvoří zákazníka (dedupe dle e-mailu) a lead se serverovým skóre', async () => {
    const c1 = await newCustomer(app, 'lead1@example.cz');
    const again = ok(await run(app, 'create_customer', { name: 'Jiné Jméno', email: 'LEAD1@example.cz' }));
    expect(again.customer_id).toBe(c1); expect(again.created).toBe(false);
    const lead = ok(await run(app, 'create_lead', { customer_id: c1, summary: 'Zájem o krytinu na rodinný dům',
      qualification: { project_type: 'sedlová střecha', area_m2: 120, timeline: '1_month', postal_code: '602 00', budget_net: 300000, is_decision_maker: true } }));
    expect(lead.status).toBe('new'); expect(lead.score).toBe(100);
  });
  test('klient nemůže zadat skóre ani status (strict schema)', async () => {
    const c = await newCustomer(app, 'lead2@example.cz');
    expect(await run(app, 'create_lead', { customer_id: c, summary: 'x yz', score: 100, status: 'qualified' })).toMatchObject({ error: { code: 'validation_error' } });
  });
  test('zákazník bez kontaktu nebo s neplatným e-mailem se nevytvoří', async () => {
    expect(await run(app, 'create_customer', { name: 'Bez Kontaktu' })).toMatchObject({ error: { code: 'validation_error' } });
    expect(await run(app, 'create_customer', { name: 'Zlý Email', email: 'neni-email' })).toMatchObject({ error: { code: 'validation_error' } });
  });
  test('lead pro neexistujícího zákazníka', async () => {
    expect(await run(app, 'create_lead', { customer_id: '00000000-0000-4000-8000-000000000000', summary: 'Test lead' })).toMatchObject({ error: { code: 'customer_not_found' } });
  });
  test('qualified vyžaduje skóre; won/lost jde přes schválení', async () => {
    const c = await newCustomer(app, 'lead3@example.cz');
    const lead = ok(await run(app, 'create_lead', { customer_id: c, summary: 'Slabý lead' }));
    expect(lead.score).toBe(20);
    expect(await run(app, 'update_lead', { lead_id: lead.lead_id, status: 'qualified' })).toMatchObject({ error: { code: 'not_qualified' } });
    const up = ok(await run(app, 'update_lead', { lead_id: lead.lead_id, status: 'qualified', qualification: { area_m2: 80, timeline: 'asap', project_type: 'střecha', postal_code: '11000' } }));
    expect(up.status).toBe('qualified'); expect(up.score).toBe(80);
    expect(await run(app, 'update_lead', { lead_id: lead.lead_id, status: 'won' })).toMatchObject({ status: 'pending_approval', category: 'status_change' });
  });
});

describe('7. projekt', () => {
  test('vytvoření a aktualizace, hodnota se odvozuje z nabídek', async () => {
    const c = await newCustomer(app, 'proj@example.cz');
    const p = ok(await run(app, 'create_project', { customer_id: c, name: 'Střecha RD Brno', project_type: 'sedlová střecha', area_m2: 100, postal_code: '60200' }));
    expect(p.status).toBe('draft');
    ok(await run(app, 'update_project', { project_id: p.project_id, status: 'calculating', notes: 'Čeká na rozměry' }));
    const q = ok(await run(app, 'create_quote', { customer_id: c, project_id: p.project_id, items: [{ product: 'DEMO-TASKA-01', qty: 1200 }] }));
    const row = (await app.db.query<any>('select status, estimated_value_net::float8 v from projects where id=$1', [p.project_id]))[0];
    expect(row.status).toBe('quoted'); expect(row.v).toBe(q.total_net);
  });
  test('projekt s leadem jiného zákazníka je odmítnut; won jde přes schválení', async () => {
    const a = await newCustomer(app, 'pa@example.cz'); const b = await newCustomer(app, 'pb@example.cz');
    const lead = ok(await run(app, 'create_lead', { customer_id: a, summary: 'Lead A' }));
    expect(await run(app, 'create_project', { customer_id: b, lead_id: lead.lead_id, name: 'Cizí projekt' })).toMatchObject({ error: { code: 'mismatch' } });
    const p = ok(await run(app, 'create_project', { customer_id: a, name: 'Projekt A' }));
    expect(await run(app, 'update_project', { project_id: p.project_id, status: 'won' })).toMatchObject({ status: 'pending_approval' });
    expect(await run(app, 'update_project', { project_id: '00000000-0000-4000-8000-000000000000', notes: 'x' })).toMatchObject({ error: { code: 'project_not_found' } });
  });
});

describe('8. nabídka', () => {
  test('ceny/sklad/doprava z DB, výpočet DPH, číslování', async () => {
    const c = await newCustomer(app, 'quote@example.cz');
    const q = ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 1200 }], shipping_postal_code: '11000' }));
    expect(q.number).toMatch(/^N-2026-\d{4}$/);
    expect(q.total_net).toBe(50100); expect(q.total_vat).toBe(10521); expect(q.total_gross).toBe(60621);
    expect(q.earliest_delivery_date).toBe('2026-10-02'); expect(q.stock_warnings).toEqual([]);
    const items = await app.db.query<any>('select unit_price_net::float8 p from quote_items');
    expect(items.some((i) => i.p === 38)).toBe(true);
  });
  test('cenu nelze zadat – strict schema odmítne unit_price/price_net/total', async () => {
    const c = await newCustomer(app, 'quote2@example.cz');
    for (const extra of [{ total_net: 1 }, { unit_price_net: 1 }]) {
      expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 10 }], ...extra })).toMatchObject({ error: { code: 'validation_error' } });
    }
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 10, price: 1 }] })).toMatchObject({ error: { code: 'validation_error' } });
  });
  test('upozornění na nedostatek skladu a pozdější termín', async () => {
    const c = await newCustomer(app, 'quote3@example.cz');
    const q = ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-02', qty: 100 }] }));
    expect(q.stock_warnings[0]).toContain('DEMO-TASKA-02'); expect(q.earliest_delivery_date).toBe('2026-10-30');
  });
  test('update_quote přepočítá z DB a nabídka se změní jen v rámci pravomocí', async () => {
    const c = await newCustomer(app, 'quote4@example.cz');
    const q = ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }] }));
    const u = ok(await run(app, 'update_quote', { quote_id: q.quote_id, items: [{ product: 'DEMO-TASKA-01', qty: 200 }], status: 'ready' }));
    expect(u.total_net).toBe(7600); expect(u.status).toBe('ready');
  });
  test('chyby: neexistující produkt/zákazník/nabídka, záporné množství', async () => {
    const c = await newCustomer(app, 'quote5@example.cz');
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'NENI', qty: 1 }] })).toMatchObject({ error: { code: 'product_not_found' } });
    expect(await run(app, 'create_quote', { customer_id: '00000000-0000-4000-8000-000000000000', items: [{ product: 'DEMO-TASKA-01', qty: 1 }] })).toMatchObject({ error: { code: 'customer_not_found' } });
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: -1 }] })).toMatchObject({ error: { code: 'validation_error' } });
    expect(await run(app, 'update_quote', { quote_id: '00000000-0000-4000-8000-000000000000', notes: 'x' })).toMatchObject({ error: { code: 'quote_not_found' } });
  });
  test('selhání uprostřed (chybějící cena) neponechá poloviční nabídku', async () => {
    const c = await newCustomer(app, 'quote6@example.cz');
    const id = await sku(app, 'DEMO-LATE-01');
    await app.db.query('update prices set valid_to=current_date-1 where product_id=$1', [id]);
    const before = (await app.db.query<any>('select count(*)::int n from quotes'))[0].n;
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 1 }, { product: 'DEMO-LATE-01', qty: 1 }] })).toMatchObject({ error: { code: 'price_not_found' } });
    expect((await app.db.query<any>('select count(*)::int n from quotes'))[0].n).toBe(before);
    await app.db.query('update prices set valid_to=null where product_id=$1', [id]);
  });
});

describe('9. follow-up', () => {
  test('vytvoření s due_in_days i due_at', async () => {
    const c = await newCustomer(app, 'fu@example.cz');
    const a = ok(await run(app, 'create_followup', { customer_id: c, due_in_days: 3, purpose: 'Zeptat se na nabídku' }));
    expect(a.due_at).toBe('2026-10-05T10:00:00.000Z');
    ok(await run(app, 'create_followup', { customer_id: c, due_at: '2026-10-20T08:00:00Z', channel: 'phone', purpose: 'Zavolat' }));
  });
  test('chyby: v minulosti, příliš daleko, bez termínu, příliš mnoho otevřených', async () => {
    const c = await newCustomer(app, 'fu2@example.cz');
    expect(await run(app, 'create_followup', { customer_id: c, due_at: '2020-01-01T00:00:00Z', purpose: 'Minulost' })).toMatchObject({ error: { code: 'past_due' } });
    expect(await run(app, 'create_followup', { customer_id: c, due_in_days: 200, purpose: 'Daleko' })).toMatchObject({ error: { code: 'too_far' } });
    expect(await run(app, 'create_followup', { customer_id: c, purpose: 'Bez termínu' })).toMatchObject({ error: { code: 'validation_error' } });
    for (let i = 0; i < 5; i++) ok(await run(app, 'create_followup', { customer_id: c, due_in_days: 2 + i, purpose: `Follow-up ${i}` }));
    expect(await run(app, 'create_followup', { customer_id: c, due_in_days: 10, purpose: 'Šestý' })).toMatchObject({ error: { code: 'too_many_followups' } });
  });
  test('splatný follow-up zpracuje komunikační agent (e-mail jde na schválení)', async () => {
    const { ScriptedProvider } = await import('../src/ai-core/index.js');
    const c = await newCustomer(app, 'fu3@example.cz');
    ok(await run(app, 'create_followup', { customer_id: c, due_in_days: 0, purpose: 'Připomenout nabídku', channel: 'email' }));
    await app.db.query(`update followups set due_at = now() - interval '1 hour' where customer_id=$1`, [c]);
    const llm = new ScriptedProvider([
      { content: null, tool_calls: [{ id: '1', name: 'send_email', arguments: JSON.stringify({ customer_id: c, subject: 'Připomenutí nabídky', body: 'Dobrý den, ozýváme se ohledně nabídky.', purpose: 'followup' }) }] },
      { content: 'E-mail čeká na schválení.', tool_calls: [] },
    ]);
    const { bootstrap } = await import('../src/beleta/bootstrap.js');
    const b = await bootstrap({ db: app.db, llm: llm, seedDemo: false, now: app.core.now });
    const r = await b.runDueFollowups();
    expect(r.processed).toBe(1);
    expect((await app.db.query<any>(`select status from followups where customer_id=$1`, [c]))[0].status).toBe('draft_created');
    expect((await app.db.query<any>(`select count(*)::int n from ai_approvals where tool='send_email' and status='pending' and input->>'customer_id'=$1`, [c]))[0].n).toBe(1);
  });
});
