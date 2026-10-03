import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError, usageReport, type LlmPricing, type ToolResult } from '../ai-core/index.js';
import { humanActor, publicActor } from '../beleta/actors.js';
import * as admin from '../beleta/admin.js';
import { eraseCustomer, exportCustomer, runRetention } from '../beleta/gdpr.js';
import { getProductAdmin, listProducts, saveProduct } from '../beleta/catalog-admin.js';
import { deleteDocument, getDocument, listDocuments, saveDocument, setDocumentActive } from '../beleta/knowledge.js';
import { scoutBudget } from '../beleta/scout.js';
import { pdfToText } from '../beleta/pdf-text.js';
import { IMPORT_TYPES, deactivateDemo, importCsv, importHelp, type ImportType } from '../beleta/import-csv.js';
import { renderQuotePdf } from '../beleta/quote-pdf.js';
import { createUser, listUsers, login, logout, totpDisable, totpEnable, totpEnabledFor, totpSetup, updateUser, userForToken, type AdminUser } from '../beleta/auth.js';
import { ROOT, type Beleta } from '../beleta/bootstrap.js';
import { DbRateLimiter, RateLimiter, type Limiter } from './ratelimit.js';

export interface ServerConfig {
  publicOrigin: string; internalToken?: string; widgetFrameAncestors?: string[]; secureCookies: boolean; trustProxy: boolean;
  llmPricing?: LlmPricing; sharedRateLimit?: boolean; chatPerMinute?: number; loginMax?: number; publicPerMinute?: number;
}

const COOKIE = 'beleta_session';
const ASSETS: Record<string, [string, string]> = {
  '/ai-sales-assets/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/ai-sales-assets/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/widget-assets/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/widget-assets/widget.css': ['widget.css', 'text/css; charset=utf-8'],
};
const uuid = z.string().uuid();

const STATUS_BY_CODE: Record<string, number> = {
  validation_error: 400, bad_message: 400, forbidden: 403, invalid_credentials: 401, unknown_tool: 404, not_found: 404,
  product_not_found: 404, price_not_found: 404, stock_unknown: 404, customer_not_found: 404, lead_not_found: 404, project_not_found: 404, quote_not_found: 404,
  not_pending: 409, already_erased: 409, user_exists: 409, no_contact: 422, scout_running: 409, no_text: 422, title_exists: 409, sku_exists: 409, quote_not_ready: 409, totp_required: 401, invalid_code: 400, totp_already_enabled: 409, totp_not_enabled: 409, ai_unavailable: 503, denied: 403,
};

export async function buildServer(app: Beleta, cfg: ServerConfig) {
  const f = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: cfg.trustProxy });
  // více instancí nad jednou DB: limity v DB (cfg.sharedRateLimit); jinak paměť procesu
  const mkLimiter = (name: string, max: number, windowMs: number): Limiter => (cfg.sharedRateLimit ? new DbRateLimiter(app.db, name, max, windowMs) : new RateLimiter(max, windowMs));
  const chatLimiter = mkLimiter('chat', cfg.chatPerMinute ?? 12, 60_000);
  const publicLimiter = mkLimiter('public', cfg.publicPerMinute ?? 120, 60_000);
  const loginLimiter = mkLimiter('login', cfg.loginMax ?? 8, 15 * 60_000);
  // prázdné tělo s Content-Type: application/json (UI posílá hlavičku i u POST/DELETE bez těla) není chyba
  f.removeContentTypeParser('application/json');
  f.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    if (raw === '') return done(null, undefined);
    try { done(null, JSON.parse(raw as string)); } catch { const e: any = new Error('Neplatný JSON'); e.statusCode = 400; done(e, undefined); }
  });
  f.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, raw, done) => done(null, raw));
  f.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const files = new Map<string, Buffer>();
  const file = (name: string) => { let b = files.get(name); if (!b) { b = readFileSync(join(ROOT, 'public', name)); files.set(name, b); } return b; };

  /* ---------- bezpečnostní hlavičky ---------- */
  f.addHook('onSend', async (req, reply) => {
    const embeddable = !!cfg.widgetFrameAncestors?.length && req.url.split('?')[0] === '/widget';
    reply.header('x-content-type-options', 'nosniff');
    if (!embeddable) reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${embeddable ? cfg.widgetFrameAncestors!.join(' ') : "'none'"}; base-uri 'none'; form-action 'self'`);
    if (cfg.secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (reply.getHeader('cache-control') === undefined) reply.header('cache-control', 'no-store');
  });

  f.setErrorHandler((err: any, req, reply) => {
    if (err instanceof DomainError) return reply.code(STATUS_BY_CODE[err.code] ?? 422).send({ error: { code: err.code, message: err.message } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: 'Neplatný požadavek' } });
    req.log?.error?.(err);
    app.core.audit.record(app.db, { actor_type: 'system', actor_id: 'system:http', action: 'http.error', status: 'error', error_code: 'internal_error', output: { path: req.url.split('?')[0] } }).catch(() => {});
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Interní chyba serveru' } });
  });

  const sendResult = (reply: FastifyReply, r: ToolResult) => {
    if (r.status === 'ok') return { data: r.data, sources: r.sources };
    if (r.status === 'pending_approval') return reply.code(202).send({ pending_approval: r });
    return reply.code(STATUS_BY_CODE[r.error.code] ?? 422).send({ error: r.error });
  };
  const runTool = (name: string, input: unknown, actor = publicActor(), requestId = randomUUID()) =>
    app.core.executor.execute(name, input, { db: app.db, actor, requestId, policy: app.core.policy, deps: app.core.deps, now: app.core.now });

  /* ---------- zdraví ---------- */
  f.get('/healthz', async () => { await app.db.query('select 1'); return { status: 'ok', ai: !!app.llm }; });

  /* ---------- statické stránky ---------- */
  const html = (name: string) => async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(file(name));
  f.get('/ai-sales', html('admin.html'));
  f.get('/ai-sales/*', html('admin.html'));
  f.get('/widget', html('widget.html'));
  for (const [url, [name, type]] of Object.entries(ASSETS)) {
    f.get(url, async (_req, reply) => reply.type(type).header('cache-control', 'no-cache').send(file(name)));
  }

  /* ---------- veřejné API (jen čtení + chat) ---------- */
  const limitPublic = async (req: FastifyRequest, reply: FastifyReply, l: Limiter) => {
    if (!(await l.take(req.ip))) { reply.code(429).header('retry-after', '60').send({ error: { code: 'rate_limited', message: 'Příliš mnoho požadavků' } }); return false; }
    return true;
  };

  f.get('/api/public/products', async (req, reply) => {
    if (!(await limitPublic(req, reply, publicLimiter))) return;
    const q = req.query as Record<string, string | undefined>;
    return sendResult(reply, await runTool('search_products', { query: q.q, category: q.category, limit: q.limit ? Number(q.limit) : undefined }));
  });
  f.get('/api/public/products/:ref', async (req, reply) => {
    if (!(await limitPublic(req, reply, publicLimiter))) return;
    const ref = (req.params as any).ref as string;
    const p = await runTool('get_product', { product: ref });
    if (p.status !== 'ok') return sendResult(reply, p);
    const price = await runTool('get_price', { product: ref });
    const stock = await runTool('check_stock', { product: ref, qty: 1 });
    return { data: { product: p.data, price: price.status === 'ok' ? price.data : null, stock: stock.status === 'ok' ? { in_stock: stock.data.in_stock, earliest_dispatch_date: stock.data.earliest_dispatch_date } : null },
      sources: [...p.sources, ...(price.status === 'ok' ? price.sources : []), ...(stock.status === 'ok' ? stock.sources : [])] };
  });
  f.post('/api/public/calculate', async (req, reply) => {
    if (!(await limitPublic(req, reply, publicLimiter))) return;
    const b = (req.body ?? {}) as any;
    const m = await runTool('calculate_material', { product: b.product, area_m2: b.area_m2 });
    if (m.status !== 'ok') return sendResult(reply, m);
    const acc = await runTool('calculate_accessories', { product: b.product, area_m2: b.area_m2, quantity: m.data.order_qty });
    return { data: { material: m.data, accessories: acc.status === 'ok' ? acc.data.items : [] }, sources: [...m.sources, ...(acc.status === 'ok' ? acc.sources : [])] };
  });
  f.post('/api/public/chat', async (req, reply) => {
    if (!(await limitPublic(req, reply, chatLimiter))) return;
    const b = z.object({ message: z.string(), conversation_id: z.string().optional() }).safeParse(req.body);
    if (!b.success) throw new DomainError('validation_error', 'Chybí message');
    const r = await app.chat({ message: b.data.message, conversationId: b.data.conversation_id });
    return { conversation_id: r.conversation_id, reply: r.reply, sources: r.sources.map((s) => ({ system: s.system, ref: s.ref, note: s.note })), awaiting_approval: r.awaiting_approval };
  });

  /* ---------- interní (n8n) ---------- */
  const internalAuth = (req: FastifyRequest) => {
    const a = Buffer.from(String(req.headers['x-internal-token'] ?? '')), b = Buffer.from(cfg.internalToken ?? '');
    return !!cfg.internalToken && a.length === b.length && timingSafeEqual(a, b);
  };
  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: { code: 'unauthorized', message: 'Neplatný token' } });
  f.post('/api/internal/followups/run-due', async (req, reply) => {
    if (!internalAuth(req)) return unauthorized(reply);
    return app.runDueFollowups();
  });
  f.post('/api/internal/scout/run', async (req, reply) => {
    if (!internalAuth(req)) return unauthorized(reply);
    return app.scout({ trigger: 'cron' });
  });
  f.post('/api/internal/gdpr/retention', async (req, reply) => {
    if (!internalAuth(req)) return unauthorized(reply);
    return runRetention(app.db, app.core.audit, Number(await app.core.policy.get('gdpr.retention_months', 0)));
  });

  /* ---------- administrace ---------- */
  const tokenOf = (req: FastifyRequest) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];
  const userOf = new WeakMap<FastifyRequest, { user: AdminUser; token: string }>();
  const cookie = (token: string, maxAge: number) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cfg.secureCookies ? '; Secure' : ''}`;

  f.addHook('onRequest', async (req, reply) => { // před parsováním těla
    if (!req.url.startsWith('/api/admin/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF: SameSite=Strict + vlastní hlavička + kontrola Origin
      const origin = req.headers.origin;
      if (req.headers['x-requested-with'] !== 'beleta-admin' || (origin && origin !== cfg.publicOrigin)) {
        return reply.code(403).send({ error: { code: 'csrf', message: 'Neplatný původ požadavku' } });
      }
    }
    if (req.url === '/api/admin/login') return;
    const token = tokenOf(req);
    const user = await userForToken(app.db, token);
    if (!user) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Přihlaste se' } });
    userOf.set(req, { user, token: token! });
  });
  const me = (req: FastifyRequest) => userOf.get(req)!;
  const needWrite = (req: FastifyRequest) => { if (me(req).user.role === 'viewer') throw new DomainError('forbidden', 'Role viewer je jen pro čtení'); };
  const needAdmin = (req: FastifyRequest) => { if (me(req).user.role !== 'admin') throw new DomainError('forbidden', 'Jen administrátor'); };

  f.post('/api/admin/login', async (req, reply) => {
    const b = z.object({ email: z.string().max(200), password: z.string().max(200), code: z.string().max(32).optional() }).safeParse(req.body);
    if (!b.success) throw new DomainError('validation_error', 'Chybí e-mail nebo heslo');
    if (!(await loginLimiter.take(`${req.ip}|${b.data.email.toLowerCase()}`))) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Příliš mnoho pokusů, zkuste to později' } });
    try {
      const { token, user } = await login(app.db, b.data.email, b.data.password, 8, b.data.code);
      await app.core.audit.record(app.db, { actor_type: 'human', actor_id: `human:${user.email}`, action: 'auth.login', status: 'success' });
      reply.header('set-cookie', cookie(token, 8 * 3600));
      return { user };
    } catch (e) {
      if (e instanceof DomainError && e.code === 'totp_required') throw e; // běžný krok přihlášení, ne selhání
      await app.core.audit.record(app.db, { actor_type: 'system', actor_id: 'system:auth', action: 'auth.login', status: 'denied', error_code: 'invalid_credentials' });
      throw e;
    }
  });
  f.post('/api/admin/logout', async (req, reply) => { await logout(app.db, me(req).token); reply.header('set-cookie', cookie('', 0)); return { ok: true }; });
  f.get('/api/admin/me', async (req) => ({ user: { ...me(req).user, totp_enabled: await totpEnabledFor(app.db, me(req).user.id) } }));
  const auditHuman = (req: FastifyRequest, action: string, entity_id?: string, output?: unknown) =>
    app.core.audit.record(app.db, { actor_type: 'human', actor_id: humanActor(me(req).user).id, action, status: 'success', entity_type: 'user', entity_id, output });
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => {
    const r = schema.safeParse(req.body ?? {}); if (!r.success) throw new DomainError('validation_error', 'Neplatný požadavek'); return r.data;
  };
  f.post('/api/admin/2fa/setup', async (req) => totpSetup(app.db, me(req).user.id));
  f.post('/api/admin/2fa/enable', async (req) => {
    const b = body(z.object({ code: z.string().max(32) }), req);
    const codes = await totpEnable(app.db, me(req).user.id, b.code, app.core.now().getTime());
    await auditHuman(req, 'auth.2fa_enable', me(req).user.id);
    return { recovery_codes: codes };
  });
  f.post('/api/admin/2fa/disable', async (req) => {
    const b = body(z.object({ password: z.string().max(200), code: z.string().max(32) }), req);
    await totpDisable(app.db, me(req).user.id, b.password, b.code);
    await auditHuman(req, 'auth.2fa_disable', me(req).user.id);
    return { ok: true };
  });

  const S = '/api/admin/ai-sales';
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const paging = (req: FastifyRequest) => ({ limit: q(req).limit ? Math.min(Number(q(req).limit) || 100, 500) : 100, offset: q(req).offset ? Number(q(req).offset) || 0 : 0 });
  f.get(`${S}/dashboard`, async () => admin.dashboard(app.db));
  f.get(`${S}/leads`, async (req) => { const p = paging(req); return admin.listLeads(app.db, q(req).status, p.limit, p.offset); });
  f.get(`${S}/projects`, async (req) => { const p = paging(req); return admin.listProjects(app.db, q(req).status, p.limit, p.offset); });
  f.get(`${S}/quotes`, async (req) => { const p = paging(req); return admin.listQuotes(app.db, q(req).status, p.limit, p.offset); });
  f.get(`${S}/quotes/:id`, async (req) => {
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const r = await admin.getQuote(app.db, id.data); if (!r) throw new DomainError('not_found', 'Nabídka neexistuje'); return r;
  });
  f.get(`${S}/quotes/:id/pdf`, async (req, reply) => {
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const { filename, buffer } = await renderQuotePdf(app.db, app.core.policy, id.data);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${filename}"`).send(buffer);
  });
  f.post(`${S}/quotes/:id/send`, async (req, reply) => {
    needWrite(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const b = body(z.object({ subject: z.string().min(3).max(200).optional(), body: z.string().min(10).max(8000).optional() }).strict(), req);
    const row = (await app.db.query<any>('select q.number, q.status, q.customer_id, c.name from quotes q join customers c on c.id=q.customer_id where q.id=$1', [id.data]))[0];
    if (!row) throw new DomainError('quote_not_found', 'Nabídka neexistuje');
    if (!['ready', 'sent'].includes(row.status)) throw new DomainError('quote_not_ready', 'Odeslat lze jen nabídku ve stavu „připraveno“ (nebo znovu odeslat „odeslanou“)');
    const actor = humanActor(me(req).user);
    const sent = await runTool('send_email', {
      customer_id: row.customer_id, quote_id: id.data, purpose: 'quote_delivery', attach_quote_pdf: true,
      subject: b.subject ?? `Nabídka ${row.number}`,
      body: b.body ?? `Dobrý den,\n\nv příloze zasíláme nabídku ${row.number}.\nPro případné dotazy nebo úpravy nás neváhejte kontaktovat.\n\nS pozdravem\nobchodní oddělení`,
    }, actor);
    if (sent.status !== 'ok') return sendResult(reply, sent);
    const status = (sent.data as any).status as string;
    if (status === 'sent' && row.status === 'ready') await runTool('update_quote', { quote_id: id.data, status: 'sent' }, actor);
    return { email_id: (sent.data as any).email_id, email_status: status };
  });
  f.get(`${S}/customers`, async (req) => { const p = paging(req); return admin.listCustomers(app.db, q(req).q, p.limit, p.offset); });
  f.get(`${S}/customers/:id`, async (req) => {
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const r = await admin.getCustomer(app.db, id.data); if (!r) throw new DomainError('customer_not_found', 'Zákazník neexistuje'); return r;
  });
  f.get(`${S}/customers/:id/export`, async (req, reply) => {
    needAdmin(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const data = await exportCustomer(app.db, app.core.audit, id.data, humanActor(me(req).user).id);
    return reply.header('content-disposition', `attachment; filename="zakaznik-${id.data}.json"`).send(data);
  });
  f.post(`${S}/customers/:id/erase`, async (req) => {
    needAdmin(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    await eraseCustomer(app.db, app.core.audit, id.data, humanActor(me(req).user).id);
    return { ok: true };
  });
  f.get(`${S}/users`, async (req) => { needAdmin(req); return listUsers(app.db); });
  f.post(`${S}/users`, async (req) => {
    needAdmin(req);
    const b = body(z.object({ email: z.string().max(200), name: z.string().max(200).optional(), role: z.enum(['admin', 'sales', 'viewer']), password: z.string().max(200) }), req);
    const id = await createUser(app.db, b);
    await auditHuman(req, 'user.create', id, { role: b.role });
    return { id };
  });
  f.patch(`${S}/users/:id`, async (req) => {
    needAdmin(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const b = body(z.object({ role: z.enum(['admin', 'sales', 'viewer']).optional(), active: z.boolean().optional(), password: z.string().max(200).optional(), reset_2fa: z.boolean().optional(), name: z.string().max(200).optional() }).strict(), req);
    await updateUser(app.db, me(req).user.id, id.data, b);
    await auditHuman(req, 'user.update', id.data, { role: b.role, active: b.active, password_reset: b.password !== undefined, reset_2fa: b.reset_2fa });
    return { ok: true };
  });
  f.get(`${S}/usage`, async (req) => usageReport(app.db, Number(q(req).days) || 30, cfg.llmPricing),
  );
  const productBody = z.object({
    sku: z.string().min(1).max(64).optional(), name: z.string().min(1).max(300).optional(), description: z.string().max(5000).optional(),
    category: z.string().min(1).max(60).optional(), unit: z.string().min(1).max(20).optional(), weight_kg: z.number().min(0).max(100000).optional(), active: z.boolean().optional(),
    attributes: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
    price_net: z.number().min(0).max(1e9).optional(), vat_rate: z.number().min(0).max(100).optional(), currency: z.string().length(3).optional(),
    stock_qty: z.number().min(0).max(1e9).optional(), lead_time_days: z.number().int().min(0).max(3650).optional(), restock_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    calc_rule: z.object({ consumption_per_m2: z.number().positive(), waste_pct: z.number().min(0).max(100).optional(), pack_size: z.number().positive().optional(), pack_label: z.string().max(30).optional(), note: z.string().max(500).optional() }).strict().optional(),
  }).strict();
  f.get(`${S}/products`, async (req) => { const p = paging(req); return listProducts(app.db, q(req).q, p.limit, p.offset); });
  f.get(`${S}/products/:id`, async (req) => {
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const r = await getProductAdmin(app.db, id.data); if (!r) throw new DomainError('not_found', 'Produkt neexistuje'); return r;
  });
  f.post(`${S}/products`, async (req) => { needAdmin(req); return saveProduct(app.db, app.core.audit, null, body(productBody, req), humanActor(me(req).user).id); });
  f.patch(`${S}/products/:id`, async (req) => {
    needAdmin(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    return saveProduct(app.db, app.core.audit, id.data, body(productBody, req), humanActor(me(req).user).id);
  });
  const kbBody = z.object({ title: z.string().min(2).max(200), content: z.string().min(10).max(500_000), category: z.string().min(1).max(60).optional(), active: z.boolean().optional() }).strict();
  const kbId = (req: FastifyRequest) => { const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id'); return id.data; };
  const kbAudit = (req: FastifyRequest, action: string, id: string, output?: unknown) =>
    app.core.audit.record(app.db, { actor_type: 'human', actor_id: humanActor(me(req).user).id, action, status: 'success', entity_type: 'kb_document', entity_id: id, output });
  f.get(`${S}/kb`, async () => listDocuments(app.db));
  f.get(`${S}/kb/:id`, async (req) => { const r = await getDocument(app.db, kbId(req)); if (!r) throw new DomainError('not_found', 'Dokument neexistuje'); return r; });
  f.post(`${S}/kb/extract`, { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    needAdmin(req);
    if (!Buffer.isBuffer(req.body)) throw new DomainError('validation_error', 'Očekáváno tělo application/pdf');
    return pdfToText(req.body); // jen náhled textu; uložení dělá admin přes POST /kb po kontrole
  });
  f.post(`${S}/kb`, { bodyLimit: 1024 * 1024 }, async (req) => {
    needAdmin(req); const b = body(kbBody, req);
    const r = await saveDocument(app.db, null, b); await kbAudit(req, 'kb.create', r.id, { title: b.title, chunks: r.chunks }); return r;
  });
  f.put(`${S}/kb/:id`, { bodyLimit: 1024 * 1024 }, async (req) => {
    needAdmin(req); const id = kbId(req); const b = body(kbBody, req);
    const r = await saveDocument(app.db, id, b); await kbAudit(req, 'kb.update', id, { title: b.title, chunks: r.chunks }); return r;
  });
  f.post(`${S}/kb/:id/active`, async (req) => {
    needAdmin(req); const id = kbId(req); const b = body(z.object({ active: z.boolean() }).strict(), req);
    await setDocumentActive(app.db, id, b.active); await kbAudit(req, 'kb.active', id, { active: b.active }); return { ok: true };
  });
  f.delete(`${S}/kb/:id`, async (req) => { needAdmin(req); const id = kbId(req); await deleteDocument(app.db, id); await kbAudit(req, 'kb.delete', id); return { ok: true }; });
  /* ---------- aktivní vyhledávání zakázek ---------- */
  f.get(`${S}/opportunities`, async (req) => {
    const p = paging(req); const st = q(req).status; const min = Number(q(req).min_score) || 0;
    return app.db.query(
      `select o.id, o.title, o.organization, o.location, o.region, o.stage, o.facade_material, o.scale_note, o.fit_score, o.status, o.url, o.contact_email is not null as has_email,
              o.contact_phone is not null as has_phone, o.draft_subject is not null as has_draft, o.found_at, o.lead_id
       from opportunities o where ($3::text is null or o.status=$3) and o.fit_score >= $4 order by o.fit_score desc, o.found_at desc limit $1 offset $2`,
      [p.limit, p.offset, st ?? null, min]);
  });
  f.get(`${S}/opportunities/:id`, async (req) => {
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const r = (await app.db.query<any>('select * from opportunities where id=$1', [id.data]))[0]; if (!r) throw new DomainError('not_found', 'Příležitost neexistuje');
    r.email_footer = String(await app.core.policy.get('scout.email_footer', ''));
    return r;
  });
  f.patch(`${S}/opportunities/:id`, async (req) => {
    needWrite(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const b = body(z.object({ status: z.enum(['new', 'reviewed', 'dismissed']) }).strict(), req);
    const r = await app.db.query(`update opportunities set status=$2, decided_by=$3, decided_at=now() where id=$1 and status <> 'promoted' returning id`, [id.data, b.status, humanActor(me(req).user).id]);
    if (!r.length) throw new DomainError('not_found', 'Příležitost nelze změnit');
    await app.core.audit.record(app.db, { actor_type: 'human', actor_id: humanActor(me(req).user).id, action: 'opportunity.status', status: 'success', entity_type: 'opportunity', entity_id: id.data, output: { status: b.status } });
    return { ok: true };
  });
  f.post(`${S}/opportunities/:id/promote`, async (req, reply) => {
    needWrite(req);
    const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const b = body(z.object({ send_email: z.boolean().optional(), subject: z.string().min(3).max(200).optional(), body: z.string().min(10).max(4000).optional() }).strict(), req);
    const o = (await app.db.query<any>('select * from opportunities where id=$1', [id.data]))[0]; if (!o) throw new DomainError('not_found', 'Příležitost neexistuje');
    if (o.status === 'promoted') throw new DomainError('not_pending', 'Příležitost už byla převedena');
    const phone = o.contact_phone && /^\+?[\d\s-]{9,16}$/.test(o.contact_phone) ? o.contact_phone : undefined;
    if (!o.contact_email && !phone) throw new DomainError('no_contact', 'Příležitost nemá použitelný kontakt – doplňte ho ručně v CRM');
    const actor = humanActor(me(req).user);
    const org = o.organization ?? o.title.slice(0, 120);
    const cust = await runTool('create_customer', { type: 'company', name: org.length >= 2 ? org : o.title.slice(0, 120), company_name: o.organization ?? undefined, email: o.contact_email ?? undefined, phone,
      note: `Příležitost z webu: ${o.url}`.slice(0, 1000), consent_marketing: false }, actor);
    if (cust.status !== 'ok') return sendResult(reply, cust);
    const customerId = (cust.data as any).customer_id as string;
    const lead = await runTool('create_lead', { customer_id: customerId, source: 'outbound', summary: `Příležitost: ${o.title} (${o.url})`.slice(0, 2000), qualification: { project_type: 'fasada_pasky_nebo_licove_cihly' } }, actor);
    if (lead.status !== 'ok') return sendResult(reply, lead);
    let email: { email_id: string; status: string } | null = null;
    if (b.send_email) {
      const subject = b.subject ?? o.draft_subject; let text = b.body ?? o.draft_body;
      if (!o.contact_email || !subject || !text) throw new DomainError('validation_error', 'Pro odeslání je nutný kontaktní e-mail, předmět a text');
      const footer = String(await app.core.policy.get('scout.email_footer', '')); if (footer && !text.includes(footer)) text += `\n\n${footer}`;
      const sent = await runTool('send_email', { customer_id: customerId, subject, body: text, purpose: 'other' }, actor);
      if (sent.status !== 'ok') return sendResult(reply, sent);
      email = { email_id: (sent.data as any).email_id, status: (sent.data as any).status };
    }
    await app.db.query(`update opportunities set status='promoted', lead_id=$2, decided_by=$3, decided_at=now() where id=$1`, [id.data, (lead.data as any).lead_id, actor.id]);
    await app.core.audit.record(app.db, { actor_type: 'human', actor_id: actor.id, action: 'opportunity.promote', status: 'success', entity_type: 'opportunity', entity_id: id.data, output: { lead_id: (lead.data as any).lead_id, email: email?.status ?? null } });
    return { customer_id: customerId, lead_id: (lead.data as any).lead_id, email };
  });
  f.get(`${S}/scout`, async () => ({
    budget: await scoutBudget(app.db, app.core.policy, app.pricing),
    search_configured: !!app.search, search_provider: app.search?.name ?? null, enabled: (await app.core.policy.get('scout.enabled', false)) === true,
    queries: await app.db.query('select id, query, active, last_run_at from scout_queries order by created_at'),
    runs: await app.db.query('select id, started_at, finished_at, status, trigger, queries, pages, analysed, found, input_tokens, output_tokens, note from scout_runs order by started_at desc limit 20'),
  }));
  f.post(`${S}/scout/run`, async (req) => { needAdmin(req); return app.scout({ trigger: 'manual', by: humanActor(me(req).user).id }); });
  f.post(`${S}/scout/queries`, async (req) => {
    needAdmin(req); const b = body(z.object({ query: z.string().min(5).max(200) }).strict(), req);
    try { await app.db.query('insert into scout_queries (query) values ($1)', [b.query.trim()]); } catch { throw new DomainError('user_exists', 'Takový dotaz už existuje'); }
    return { ok: true };
  });
  f.patch(`${S}/scout/queries/:id`, async (req) => {
    needAdmin(req); const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    const b = body(z.object({ active: z.boolean() }).strict(), req);
    if (!(await app.db.query('update scout_queries set active=$2 where id=$1 returning id', [id.data, b.active])).length) throw new DomainError('not_found', 'Dotaz neexistuje');
    return { ok: true };
  });
  f.delete(`${S}/scout/queries/:id`, async (req) => {
    needAdmin(req); const id = uuid.safeParse((req.params as any).id); if (!id.success) throw new DomainError('validation_error', 'Neplatné id');
    await app.db.query('delete from scout_queries where id=$1', [id.data]); return { ok: true };
  });
  f.get(`${S}/import`, async (req) => { needAdmin(req); return { types: importHelp() }; });
  f.post(`${S}/import/:type`, { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    needAdmin(req);
    const type = (req.params as any).type as string;
    if (!(IMPORT_TYPES as readonly string[]).includes(type)) throw new DomainError('validation_error', 'Neznámý typ importu');
    if (typeof req.body !== 'string') throw new DomainError('validation_error', 'Očekáváno tělo text/csv');
    return importCsv(app.db, app.core.audit, type as ImportType, req.body, { dryRun: ['1', 'true'].includes(q(req).dry_run ?? ''), by: humanActor(me(req).user).id });
  });
  f.post(`${S}/demo/deactivate`, async (req) => { needAdmin(req); return { deactivated: await deactivateDemo(app.db, app.core.audit, humanActor(me(req).user).id) }; });
  f.get(`${S}/followups`, async (req) => { const p = paging(req); return admin.listFollowups(app.db, q(req).status, p.limit, p.offset); });
  f.get(`${S}/emails`, async (req) => admin.listEmails(app.db, paging(req).limit));
  f.get(`${S}/approvals`, async (req) => app.core.approvals.list(app.db, q(req).status, paging(req).limit));
  f.get(`${S}/activity`, async (req) => { const p = paging(req); return app.core.audit.list(app.db, { tool: q(req).tool, status: q(req).status, actor: q(req).actor, limit: p.limit, offset: p.offset }); });
  f.get(`${S}/audit/verify`, async () => app.core.audit.verifyChain(app.db));
  f.get(`${S}/policies`, async () => app.core.policy.list());

  f.post(`${S}/approvals/:id/:decision`, async (req) => {
    needWrite(req);
    const { id, decision } = req.params as any;
    if (!uuid.safeParse(id).success || !['approve', 'reject'].includes(decision)) throw new DomainError('validation_error', 'Neplatný požadavek');
    const body = z.object({ note: z.string().max(1000).optional() }).safeParse(req.body ?? {});
    return app.core.approvals.decide(app.db, id, decision, humanActor(me(req).user), body.success ? body.data.note : undefined, randomUUID());
  });
  f.post(`${S}/followups/:id/:action`, async (req, reply) => {
    needWrite(req);
    const { id, action } = req.params as any;
    if (!uuid.safeParse(id).success || !['done', 'cancel'].includes(action)) throw new DomainError('validation_error', 'Neplatný požadavek');
    const r = await admin.setFollowupStatus(app.db, id, action === 'done' ? 'done' : 'cancelled');
    if (!r.length) throw new DomainError('not_found', 'Follow-up nelze změnit');
    await app.core.audit.record(app.db, { actor_type: 'human', actor_id: humanActor(me(req).user).id, action: 'followup.status', status: 'success', entity_type: 'followup', entity_id: id, output: { action } });
    return reply.send({ ok: true });
  });
  f.patch(`${S}/leads/:id`, async (req, reply) => {
    needWrite(req);
    const r = await runTool('update_lead', { lead_id: (req.params as any).id, ...((req.body as object) ?? {}) }, humanActor(me(req).user));
    return sendResult(reply, r);
  });
  f.patch(`${S}/quotes/:id`, async (req, reply) => {
    needWrite(req);
    const r = await runTool('update_quote', { quote_id: (req.params as any).id, ...((req.body as object) ?? {}) }, humanActor(me(req).user));
    return sendResult(reply, r);
  });
  f.put(`${S}/policies/:key`, async (req) => {
    needAdmin(req);
    const key = (req.params as any).key as string;
    const b = z.object({ value: z.union([z.number(), z.boolean(), z.string()]) }).safeParse(req.body);
    if (!b.success) throw new DomainError('validation_error', 'Neplatná hodnota');
    const cur = (await app.core.policy.list() as any[]).find((p) => p.key === key);
    if (!cur) throw new DomainError('not_found', 'Neznámá politika');
    if (typeof cur.value !== typeof b.data.value) throw new DomainError('validation_error', `Očekáván typ ${typeof cur.value}`);
    await app.core.policy.set(key, b.data.value, humanActor(me(req).user).id);
    await app.core.audit.record(app.db, { actor_type: 'human', actor_id: humanActor(me(req).user).id, action: 'policy.update', status: 'success', entity_type: 'policy', entity_id: key, output: { from: cur.value, to: b.data.value } });
    return { ok: true };
  });

  return f;
}
