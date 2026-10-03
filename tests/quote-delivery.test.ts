import { describe, expect, test } from 'vitest';
import { bootstrap } from '../src/beleta/bootstrap.js';
import { buildServer } from '../src/server/app.js';
import { N8nWebhookTransport, type EmailMessage, type EmailTransport } from '../src/beleta/email.js';
import { createQuote } from '../src/beleta/crm.js';
import { makeApp, newCustomer, ok, run, human, ai } from './helpers.js';

const capture = (): EmailTransport & { sent: EmailMessage[] } => { const sent: EmailMessage[] = []; return { name: 'cap', sent, async send(m) { sent.push(m); } }; };
const mk = (now: string, t?: EmailTransport) => bootstrap({ emailTransport: t, now: () => new Date(now), admin: { email: 'admin@test.cz', password: 'test-password-123' } });

describe('číslování nabídek po letech', () => {
  test('každý rok od 1, v rámci roku průběžně', async () => {
    const app = await mk('2026-12-31T10:00:00Z');
    const c = await newCustomer(app);
    const mkq = async (date: string) => (await createQuote(app.db, app.core.policy, { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 1 }] } as any, ai, new Date(date))).number;
    expect(await mkq('2026-12-30T10:00:00Z')).toBe('N-2026-0001');
    expect(await mkq('2026-12-31T10:00:00Z')).toBe('N-2026-0002');
    expect(await mkq('2027-01-02T10:00:00Z')).toBe('N-2027-0001');
    expect(await mkq('2027-01-03T10:00:00Z')).toBe('N-2027-0002');
  });
});

describe('odeslání nabídky s PDF', () => {
  test('send_email s attach_quote_pdf přiloží PDF; cizí nabídka a chybějící quote_id se odmítnou', async () => {
    const t = capture(); const app = await mk('2026-10-02T10:00:00Z', t);
    const c = await newCustomer(app); const other = await newCustomer(app, 'jiny@example.cz');
    const q = ok<any>(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 5 }] }));
    const r = ok<any>(await run(app, 'send_email', { customer_id: c, subject: 'Nabídka', body: 'V příloze nabídka.', quote_id: q.quote_id, attach_quote_pdf: true }, human));
    expect(r.status).toBe('sent');
    expect(t.sent[0].attachments?.[0]).toMatchObject({ contentType: 'application/pdf' });
    expect(t.sent[0].attachments![0].content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await run(app, 'send_email', { customer_id: other, subject: 'Nabídka', body: 'V příloze nabídka.', quote_id: q.quote_id, attach_quote_pdf: true }, human)).toMatchObject({ error: { code: 'quote_mismatch' } });
    expect(await run(app, 'send_email', { customer_id: c, subject: 'Nabídka', body: 'V příloze nabídka.', attach_quote_pdf: true }, human)).toMatchObject({ error: { code: 'no_quote' } });
  });
  test('n8n webhook posílá přílohu jako base64', async () => {
    let body: any;
    const t = new N8nWebhookTransport('http://n', (async (_u: any, o: any) => { body = JSON.parse(o.body); return { ok: true }; }) as any);
    await t.send({ to: 'a@b.cz', subject: 's', body: 'b', ref: 'r', attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', content: Buffer.from('hi') }] });
    expect(body.attachments[0]).toEqual({ filename: 'x.pdf', contentType: 'application/pdf', content_base64: 'aGk=' });
  });
  test('REST: odeslat jde jen „připravenou“ nabídku; po odeslání je stav sent', async () => {
    const t = capture(); const app = await mk('2026-10-02T10:00:00Z', t);
    const c = await newCustomer(app);
    const q = ok<any>(await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 5 }] }));
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    const send = () => srv.inject({ method: 'POST', url: `/api/admin/ai-sales/quotes/${q.quote_id}/send`, headers: { ...H, cookie }, payload: {} });
    expect((await send()).statusCode).toBe(409); // draft
    await app.db.query(`update quotes set status='ready' where id=$1`, [q.quote_id]);
    const r = await send(); expect(r.statusCode).toBe(200); expect(r.json().email_status).toBe('sent');
    expect(t.sent.length).toBe(1);
    expect((await app.db.query<any>('select status from quotes where id=$1', [q.quote_id]))[0].status).toBe('sent');
    await srv.close();
  });
});
void makeApp;
