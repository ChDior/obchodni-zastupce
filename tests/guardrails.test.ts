import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Beleta } from '../src/beleta/bootstrap.js';
import { ai, human, makeApp, newCustomer, ok, run } from './helpers.js';

let app: Beleta;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

const decide = (id: string, d: 'approve' | 'reject', note?: string, actor = human) => app.core.approvals.decide(app.db, id, d, actor, note, 'req-test');
const quoteCount = async () => (await app.db.query<any>('select count(*)::int n from quotes'))[0].n;

describe('11. odmítnutí neoprávněné slevy', () => {
  test('AI sleva nad limit se NEPROVEDE a jde ke schválení', async () => {
    const c = await newCustomer(app, 'disc@example.cz');
    const before = await quoteCount();
    const r = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 10 });
    expect(r).toMatchObject({ status: 'pending_approval', category: 'discount' });
    expect(await quoteCount()).toBe(before); // nic se nezapsalo
  });
  test('změna limitu v politice (člověkem) povolí nízkou slevu bez schválení', async () => {
    const c = await newCustomer(app, 'disc2@example.cz');
    await app.core.policy.set('discount.max_auto_pct', 3, 'human:test');
    ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 3 }));
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 3.5 })).toMatchObject({ status: 'pending_approval' });
    await app.core.policy.set('discount.max_auto_pct', 0, 'human:test');
  });
  test('sleva přidaná dodatečně přes update_quote také vyžaduje schválení', async () => {
    const c = await newCustomer(app, 'disc3@example.cz');
    const q = ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }] }));
    expect(await run(app, 'update_quote', { quote_id: q.quote_id, discount_pct: 15 })).toMatchObject({ status: 'pending_approval', category: 'discount' });
    expect((await app.db.query<any>('select discount_pct::float8 d from quotes where id=$1', [q.quote_id]))[0].d).toBe(0);
  });
});

describe('10. human approval', () => {
  test('schválení provede původní akci s původním vstupem a zaznamená schvalovatele', async () => {
    const c = await newCustomer(app, 'appr@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 10 });
    const done = await decide(r.approval_id, 'approve', 'OK, věrný zákazník');
    expect(done.status).toBe('executed'); expect(done.decided_by).toBe(human.id);
    const q = (await app.db.query<any>(`select discount_pct::float8 d, total_net::float8 t, created_by from quotes where customer_id=$1`, [c]))[0];
    expect(q.d).toBe(10); expect(q.t).toBe(3420); expect(q.created_by).toBe(ai.id);
    const audit = await app.db.query<any>(`select action, status from ai_audit_log where approval_id=$1 order by id`, [r.approval_id]);
    expect(audit.map((a) => a.action)).toEqual(['approval.created', 'approval.decided', 'tool.call.approved']);
  });
  test('zamítnutí akci neprovede', async () => {
    const c = await newCustomer(app, 'rej@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 20 });
    expect((await decide(r.approval_id, 'reject', 'Ne')).status).toBe('rejected');
    expect((await app.db.query<any>('select count(*)::int n from quotes where customer_id=$1', [c]))[0].n).toBe(0);
  });
  test('rozhodnout lze jen jednou; neexistující id; AI nemůže schvalovat', async () => {
    const c = await newCustomer(app, 'once@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 5 });
    await decide(r.approval_id, 'approve');
    await expect(decide(r.approval_id, 'approve')).rejects.toMatchObject({ code: 'not_pending' });
    await expect(decide('00000000-0000-4000-8000-000000000000', 'approve')).rejects.toMatchObject({ code: 'not_found' });
    const r2: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 5 });
    await expect(decide(r2.approval_id, 'approve', undefined, ai)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await app.core.approvals.get(app.db, r2.approval_id)).status).toBe('pending');
  });
  test('prošlá žádost nejde schválit', async () => {
    const c = await newCustomer(app, 'exp@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 5 });
    await app.db.query(`update ai_approvals set expires_at = now() - interval '1 minute' where id=$1`, [r.approval_id]);
    await expect(decide(r.approval_id, 'approve')).rejects.toMatchObject({ code: 'not_pending' });
    expect((await app.core.approvals.get(app.db, r.approval_id)).status).toBe('expired');
  });
  test('schválená akce, která už neprojde (zákazník zmizel), skončí failed a ne tichým úspěchem', async () => {
    const c = await newCustomer(app, 'gone@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 5 });
    await app.db.query('delete from customers where id=$1', [c]);
    const done = await decide(r.approval_id, 'approve');
    expect(done.status).toBe('failed'); expect(done.error).toContain('customer_not_found');
  });
  test('request_human_approval: právní spor / reklamace / cena vytvoří žádost bez akce', async () => {
    for (const category of ['legal', 'complaint', 'price_change', 'terms'] as const) {
      const r = ok(await run(app, 'request_human_approval', { category, summary: `Zákazník řeší: ${category}`, reason: 'Mimo pravomoc AI' }));
      expect(r.status).toBe('pending');
      const ap = await app.core.approvals.get(app.db, r.approval_id);
      expect(ap.tool).toBeNull(); expect(ap.category).toBe(category);
      expect((await decide(r.approval_id, 'approve', 'Převzal jsem')).status).toBe('approved');
    }
  });
});

describe('další guardrails', () => {
  test('nestandardní podmínky a dřívější termín vyžadují schválení', async () => {
    const c = await newCustomer(app, 'terms@example.cz');
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], custom_terms: 'Splatnost 90 dní' })).toMatchObject({ status: 'pending_approval', category: 'terms' });
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-02', qty: 100 }], requested_delivery_date: '2026-10-10' })).toMatchObject({ status: 'pending_approval', category: 'delivery_date' });
    ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-02', qty: 100 }], requested_delivery_date: '2026-11-15' }));
  });
  test('vysoká hodnota nabídky vyžaduje schválení', async () => {
    const c = await newCustomer(app, 'big@example.cz');
    expect(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 14000 }] })).toMatchObject({ status: 'pending_approval', category: 'quote_value' });
  });
  test('AI nesmí nastavit sent/accepted a měnit odeslanou nabídku; člověk ano', async () => {
    const c = await newCustomer(app, 'lock@example.cz');
    const q = ok(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }] }));
    expect(await run(app, 'update_quote', { quote_id: q.quote_id, status: 'sent' })).toMatchObject({ error: { code: 'status_not_allowed' } });
    ok(await run(app, 'update_quote', { quote_id: q.quote_id, status: 'sent' }, human));
    expect(await run(app, 'update_quote', { quote_id: q.quote_id, notes: 'změna' })).toMatchObject({ error: { code: 'quote_locked' } });
  });
  test('e-mail AI: ke schválení; příjemce nelze zadat; po schválení odejde na adresu z CRM', async () => {
    const c = await newCustomer(app, 'mail@example.cz');
    expect(await run(app, 'send_email', { customer_id: c, to: 'oběť@cizi.cz', subject: 'Test', body: 'Dlouhý text e-mailu' })).toMatchObject({ error: { code: 'validation_error' } });
    const r: any = await run(app, 'send_email', { customer_id: c, subject: 'Vaše nabídka', body: 'Dobrý den, posíláme nabídku.', purpose: 'quote_delivery' });
    expect(r.status).toBe('pending_approval');
    expect((await app.db.query<any>('select count(*)::int n from email_outbox where customer_id=$1', [c]))[0].n).toBe(0);
    const done = await decide(r.approval_id, 'approve');
    expect(done.status).toBe('executed');
    const row = (await app.db.query<any>('select to_email, status, created_by from email_outbox where customer_id=$1', [c]))[0];
    expect(row).toMatchObject({ to_email: 'mail@example.cz', status: 'sent', created_by: ai.id });
  });
  test('e-mail: auto-send politika + denní limit + zákazník bez e-mailu', async () => {
    const c = await newCustomer(app, 'mail2@example.cz');
    await app.core.policy.set('email.ai_auto_send', true, 'human:test');
    expect(ok(await run(app, 'send_email', { customer_id: c, subject: 'Přímo', body: 'Text e-mailu bez schvalování.' })).status).toBe('sent');
    await app.core.policy.set('email.daily_limit', 1, 'human:test');
    expect(await run(app, 'send_email', { customer_id: c, subject: 'Druhý', body: 'Text druhého e-mailu.' })).toMatchObject({ error: { code: 'daily_limit' } });
    await app.core.policy.set('email.ai_auto_send', false, 'human:test'); await app.core.policy.set('email.daily_limit', 50, 'human:test');
    const phoneOnly = ok(await run(app, 'create_customer', { name: 'Jen Telefon', phone: '+420 602 111 222' })).customer_id;
    expect(await run(app, 'send_email', { customer_id: phoneOnly, subject: 'Nemá mail', body: 'Text e-mailu.' })).toMatchObject({ error: { code: 'no_recipient' } });
  });
  test('selhání transportu = záznam failed, ne pád', async () => {
    const c = await newCustomer(app, 'mail3@example.cz');
    await app.core.policy.set('email.ai_auto_send', true, 'human:test');
    const orig = app.core.deps.emailTransport;
    app.core.deps.emailTransport = { name: 'broken', send: async () => { throw new Error('smtp down'); } };
    expect(ok(await run(app, 'send_email', { customer_id: c, subject: 'Selže', body: 'Text e-mailu.' })).status).toBe('failed');
    app.core.deps.emailTransport = orig;
    await app.core.policy.set('email.ai_auto_send', false, 'human:test');
  });
});
