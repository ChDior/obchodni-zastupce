import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ScriptedProvider } from '../src/ai-core/index.js';
import { bootstrap, type Beleta } from '../src/beleta/bootstrap.js';
import { buildServer } from '../src/server/app.js';
import { RateLimiter } from '../src/server/ratelimit.js';
import { makeApp, newCustomer, ok, run } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
let app: Beleta; let srv: Awaited<ReturnType<typeof buildServer>>; let cookie = '';
const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
const admin = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  srv.inject({ method: method as any, url, payload: payload as any, headers: { ...H, cookie, ...headers } });

beforeAll(async () => {
  const llm = new ScriptedProvider([{ content: 'Dobrý den, jak mohu pomoci?', tool_calls: [] }]);
  app = await bootstrap({ llm, now: () => new Date('2026-10-02T10:00:00Z'), admin: { email: 'admin@test.cz', password: 'test-password-123' } });
  srv = await buildServer(app, { publicOrigin: ORIGIN, internalToken: 'internal-token-internal-token', secureCookies: false, trustProxy: false, chatPerMinute: 3, loginMax: 4 });
  const r = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
  expect(r.statusCode).toBe(200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
afterAll(async () => { await srv.close(); await app.close(); });

describe('veřejné API', () => {
  test('healthz, hlavičky, vyhledávání, detail s cenou a skladem', async () => {
    const hz = await srv.inject('/healthz'); expect(hz.json()).toEqual({ status: 'ok', ai: true });
    expect(hz.headers['content-security-policy']).toContain("default-src 'self'"); expect(hz.headers['x-frame-options']).toBe('DENY'); expect(hz.headers['x-content-type-options']).toBe('nosniff');
    const s = (await srv.inject('/api/public/products?q=klasik')).json(); expect(s.data.products[0].sku).toBe('DEMO-TASKA-01');
    const d = (await srv.inject('/api/public/products/DEMO-TASKA-01')).json();
    expect(d.data.price.amount_net).toBe(38); expect(d.data.stock.in_stock).toBe(true); expect(d.sources.length).toBeGreaterThanOrEqual(3);
    expect((await srv.inject('/api/public/products/NENI')).statusCode).toBe(404);
  });
  test('kalkulace 100 m² přes REST + chyby', async () => {
    const r = (await srv.inject({ method: 'POST', url: '/api/public/calculate', payload: { product: 'DEMO-TASKA-01', area_m2: 100 } })).json();
    expect(r.data.material.order_qty).toBe(1200); expect(r.data.accessories.length).toBe(3);
    expect((await srv.inject({ method: 'POST', url: '/api/public/calculate', payload: { product: 'DEMO-TASKA-01', area_m2: -1 } })).statusCode).toBe(400);
  });
  test('veřejné API nemá žádný zápisový endpoint do CRM (i přes tool jména)', async () => {
    expect((await srv.inject({ method: 'POST', url: '/api/public/tools/create_quote', payload: {} })).statusCode).toBe(404);
  });
  test('chat: odpověď, rate limit 429, špatný vstup', async () => {
    const ok1 = await srv.inject({ method: 'POST', url: '/api/public/chat', payload: { message: 'Dobrý den' } });
    expect(ok1.statusCode).toBe(200); expect(ok1.json().reply).toContain('Dobrý den');
    expect((await srv.inject({ method: 'POST', url: '/api/public/chat', payload: {} })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'POST', url: '/api/public/chat', payload: { message: 'x'.repeat(5000) } })).statusCode).toBe(400);
    const last = await srv.inject({ method: 'POST', url: '/api/public/chat', payload: { message: 'ještě' } });
    expect(last.statusCode).toBe(429);
  });
  test('příliš velké tělo je odmítnuto', async () => {
    const r = await srv.inject({ method: 'POST', url: '/api/public/calculate', payload: { product: 'x'.repeat(100_000) } });
    expect(r.statusCode).toBe(413);
  });
});

describe('administrace – autentizace a bezpečnost', () => {
  test('bez přihlášení 401, špatné heslo 401, rate limit loginu', async () => {
    expect((await srv.inject({ method: 'GET', url: '/api/admin/ai-sales/dashboard' })).statusCode).toBe(401);
    expect((await srv.inject({ method: 'GET', url: '/api/admin/ai-sales/dashboard', headers: { cookie: 'beleta_session=' + 'a'.repeat(64) } })).statusCode).toBe(401);
    const bad = () => srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'špatně' } });
    expect((await bad()).statusCode).toBe(401); expect((await bad()).statusCode).toBe(401); expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
  });
  test('cookie je HttpOnly + SameSite=Strict, heslo není v odpovědi', async () => {
    const app2 = await bootstrap({ db: app.db, seedDemo: false });
    const s2 = await buildServer(app2, { publicOrigin: ORIGIN, secureCookies: true, trustProxy: false });
    const r = await s2.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const c = String(r.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/SameSite=Strict/); expect(c).toMatch(/Secure/);
    expect(r.body).not.toMatch(/password|hash|scrypt/i); expect(r.headers['strict-transport-security']).toBeTruthy();
    await s2.close();
  });
  test('CSRF: zápis bez hlavičky nebo s cizím Origin je odmítnut', async () => {
    const noHdr = await srv.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie } });
    expect(noHdr.statusCode).toBe(403);
    const evil = await srv.inject({ method: 'POST', url: '/api/admin/logout', headers: { ...H, cookie, origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
  });
  test('viewer nemůže schvalovat; ne-admin nemůže měnit politiky', async () => {
    await app.db.query(`insert into admin_users (email, role, password_hash) values ('v@test.cz','viewer','x')`);
    const { token } = await (await import('../src/beleta/auth.js')).login(app.db, 'admin@test.cz', 'test-password-123');
    const uid = (await app.db.query<any>(`select id from admin_users where email='v@test.cz'`))[0].id;
    const crypto = await import('node:crypto');
    const tok = crypto.randomBytes(32).toString('hex');
    await app.db.query(`insert into admin_sessions (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 hour')`, [crypto.createHash('sha256').update(tok).digest('hex'), uid]);
    const vh = { cookie: `beleta_session=${tok}` };
    expect((await admin('GET', '/api/admin/ai-sales/dashboard', undefined, vh)).statusCode).toBe(200);
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await admin('POST', `/api/admin/ai-sales/approvals/${id}/approve`, {}, vh)).statusCode).toBe(403);
    expect((await admin('PUT', '/api/admin/ai-sales/policies/discount.max_auto_pct', { value: 50 }, vh)).statusCode).toBe(403);
    void token;
  });
});

describe('administrace AI SALES – workflow', () => {
  test('stránky a assety se servírují', async () => {
    for (const u of ['/ai-sales', '/ai-sales/approvals', '/ai-sales-assets/admin.js', '/ai-sales-assets/admin.css', '/widget', '/widget-assets/widget.js']) {
      const r = await srv.inject(u); expect(r.statusCode, u).toBe(200);
    }
    expect((await srv.inject('/ai-sales-assets/../package.json')).statusCode).toBe(404);
    expect((await srv.inject('/ai-sales')).body).not.toContain('<script>');
  });
  test('dashboard + seznamy + schválení nabídky se slevou end-to-end', async () => {
    const c = await newCustomer(app, 'admin-e2e@example.cz');
    const lead = ok(await run(app, 'create_lead', { customer_id: c, summary: 'E2E lead <script>alert(1)</script>' }));
    const q: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 100 }], discount_pct: 12 });
    expect(q.status).toBe('pending_approval');
    const dash = (await admin('GET', '/api/admin/ai-sales/dashboard')).json();
    expect(dash.pending_approvals).toBeGreaterThanOrEqual(1); expect(dash.new_leads).toBeGreaterThanOrEqual(1);
    const leads = (await admin('GET', '/api/admin/ai-sales/leads?status=new')).json();
    expect(leads.find((l: any) => l.id === lead.lead_id).summary).toContain('<script>'); // data se vrací jako data; UI je vkládá přes textContent
    const pend = (await admin('GET', '/api/admin/ai-sales/approvals?status=pending')).json();
    expect(pend.some((a: any) => a.id === q.approval_id)).toBe(true);
    const dec = await admin('POST', `/api/admin/ai-sales/approvals/${q.approval_id}/approve`, { note: 'ok' });
    expect(dec.statusCode).toBe(200); expect(dec.json().status).toBe('executed'); expect(dec.json().decided_by).toBe('human:admin@test.cz');
    expect((await admin('POST', `/api/admin/ai-sales/approvals/${q.approval_id}/approve`, {})).statusCode).toBe(409);
    const quotes = (await admin('GET', '/api/admin/ai-sales/quotes')).json();
    const created = quotes.find((x: any) => x.customer_id === c);
    expect(created.discount_pct).toBe(12);
    const detail = (await admin('GET', `/api/admin/ai-sales/quotes/${created.id}`)).json(); expect(detail.items[0].sku).toBe('DEMO-TASKA-01');
    const sent = await admin('PATCH', `/api/admin/ai-sales/quotes/${created.id}`, { status: 'sent' }); expect(sent.statusCode).toBe(200);
    const act = (await admin('GET', '/api/admin/ai-sales/activity?tool=create_quote')).json();
    expect(act.some((a: any) => a.action === 'tool.call.approved' && a.actor_id === 'ai:web-advisor')).toBe(true);
    expect((await admin('GET', '/api/admin/ai-sales/audit/verify')).json().ok).toBe(true);
  });
  test('follow-upy a politiky (typová kontrola, audit změny)', async () => {
    const c = await newCustomer(app, 'admin-fu@example.cz');
    const fu = ok(await run(app, 'create_followup', { customer_id: c, due_in_days: 1, purpose: 'Zavolat zpět' }));
    expect((await admin('POST', `/api/admin/ai-sales/followups/${fu.followup_id}/done`, {})).statusCode).toBe(200);
    expect((await admin('POST', `/api/admin/ai-sales/followups/${fu.followup_id}/done`, {})).statusCode).toBe(404);
    expect((await admin('PUT', '/api/admin/ai-sales/policies/discount.max_auto_pct', { value: 'hodně' })).statusCode).toBe(400);
    expect((await admin('PUT', '/api/admin/ai-sales/policies/neexistuje', { value: 1 })).statusCode).toBe(404);
    expect((await admin('PUT', '/api/admin/ai-sales/policies/discount.max_auto_pct', { value: 2 })).statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/ai-sales/activity?tool=')).json().some((a: any) => a.action === 'policy.update')).toBe(true);
    await admin('PUT', '/api/admin/ai-sales/policies/discount.max_auto_pct', { value: 0 });
  });
  test('neplatné id v URL -> 400', async () => {
    expect((await admin('GET', '/api/admin/ai-sales/quotes/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('interní endpoint pro n8n', () => {
  test('vyžaduje token (constant-time), jinak 401; s tokenem zpracuje follow-upy', async () => {
    expect((await srv.inject({ method: 'POST', url: '/api/internal/followups/run-due' })).statusCode).toBe(401);
    expect((await srv.inject({ method: 'POST', url: '/api/internal/followups/run-due', headers: { 'x-internal-token': 'wrong' } })).statusCode).toBe(401);
    const r = await srv.inject({ method: 'POST', url: '/api/internal/followups/run-due', headers: { 'x-internal-token': 'internal-token-internal-token' } });
    expect(r.statusCode).toBe(200); expect(r.json()).toHaveProperty('processed');
  });
  test('bez nakonfigurovaného tokenu je endpoint zavřený', async () => {
    const s = await buildServer(app, { publicOrigin: ORIGIN, secureCookies: false, trustProxy: false });
    expect((await s.inject({ method: 'POST', url: '/api/internal/followups/run-due', headers: { 'x-internal-token': '' } })).statusCode).toBe(401);
    await s.close();
  });
});

describe('RateLimiter', () => {
  test('okno se posouvá', () => {
    let t = 0; const l = new RateLimiter(2, 1000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, false]);
    t = 1500; expect(l.take('a')).toBe(true); expect(l.take('b')).toBe(true);
  });
});
void makeApp;

describe('vložení widgetu a profil webu', () => {
  test('výchozí = weby profilu cihlovestavby; přepnutí na beleta; [] = nikdo; override; administrace nikdy', async () => {
    const a = await makeApp();
    const csp = async (srv: any, url = '/widget') => String((await srv.inject(url)).headers['content-security-policy']);
    const dflt = await buildServer(a, { publicOrigin: ORIGIN, secureCookies: false, trustProxy: false });
    expect(await csp(dflt)).toContain('frame-ancestors https://www.cihlovestavby.cz https://cihlovestavby.cz;');
    expect((await dflt.inject('/widget')).headers['x-frame-options']).toBeUndefined();
    await a.core.policy.set('site.profile', 'beleta', 't');
    expect(await csp(dflt)).toContain('frame-ancestors https://www.beleta.cz https://beleta.cz;');
    expect((await dflt.inject('/api/public/site')).json()).toMatchObject({ id: 'beleta', brand: 'BELETA Plus' });
    expect(await csp(dflt, '/ai-sales')).toContain("frame-ancestors 'none'");
    expect((await dflt.inject('/ai-sales')).headers['x-frame-options']).toBe('DENY');
    const none = await buildServer(a, { publicOrigin: ORIGIN, secureCookies: false, trustProxy: false, widgetFrameAncestors: [] });
    expect(await csp(none)).toContain("frame-ancestors 'none'"); expect((await none.inject('/widget')).headers['x-frame-options']).toBe('DENY');
    const over = await buildServer(a, { publicOrigin: ORIGIN, secureCookies: false, trustProxy: false, widgetFrameAncestors: ['https://jiny.example'] });
    expect(await csp(over)).toContain('frame-ancestors https://jiny.example;');
    const emb = await dflt.inject('/widget-assets/embed.js'); expect(emb.statusCode).toBe(200); expect(emb.headers['content-type']).toContain('javascript');
    await dflt.close(); await none.close(); await over.close();
  });
  test('profil lze přepnout jen platnou hodnotou; poradce dostane kontext webu', async () => {
    const llm = new ScriptedProvider([{ content: 'Dobrý den!', tool_calls: [] }]);
    const app = await bootstrap({ llm, admin: { email: 'admin@test.cz', password: 'test-password-123' } });
    const srv = await buildServer(app, { publicOrigin: ORIGIN, secureCookies: false, trustProxy: false });
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const cookie = String(l.headers['set-cookie']).split(';')[0];
    const put = (v: string) => srv.inject({ method: 'PUT', url: '/api/admin/ai-sales/policies/site.profile', headers: { ...H, cookie }, payload: { value: v } });
    expect((await put('neexistuje')).statusCode).toBe(400);
    expect((await put('beleta')).statusCode).toBe(200);
    await app.chat({ message: 'Ahoj' });
    expect(llm.requests[0].system).toContain('BELETA Plus (www.beleta.cz)');
    expect((await srv.inject({ url: '/api/admin/me', headers: { cookie } })).json().site.id).toBe('beleta');
    await srv.close(); await app.close();
  });
});
