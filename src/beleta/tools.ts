import { z } from 'zod';
import { DomainError, type ToolDefinition } from '../ai-core/index.js';
import { SCOPES } from './actors.js';
import { checkStock, getPrice, getProduct, resolveProduct, searchProducts, src } from './catalog.js';
import { calculateAccessories, calculateMaterial, calculateShipping } from './calc.js';
import * as crm from './crm.js';
import { dailyAiEmailCount, type EmailAttachment } from './email.js';
import { renderQuotePdf } from './quote-pdf.js';
import { hasFacadeKeyword, csv, normQuote, scoreOpportunity, urlKey } from './scout.js';
import type { KnowledgeProvider } from './knowledge.js';
import { dateStr, isoDate, num } from './util.js';

const productRef = z.string().min(1).max(64).describe('UUID nebo SKU produktu');
const uuid = z.string().uuid();
const money = z.number().finite();
const postal = z.string().regex(/^\d{3}\s?\d{2}$/, 'PSČ ve tvaru 123 45');

const qualification = z.object({
  project_type: z.string().max(60).optional(),
  area_m2: z.number().positive().max(100000).optional(),
  timeline: z.enum(['asap', '1_month', '3_months', 'later', 'unknown']).optional(),
  budget_net: money.positive().optional(),
  postal_code: postal.optional(),
  is_decision_maker: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
}).strict();

const quoteItem = z.object({ product: productRef, qty: z.number().positive().max(1_000_000) }).strict();

type T = ToolDefinition<any, any>;
const def = <I, O>(d: ToolDefinition<I, O>): T => d as unknown as T;

export interface BuildToolsDeps { knowledge: KnowledgeProvider }

export function buildTools({ knowledge }: BuildToolsDeps): T[] {
  return [
    /* ------------------------------ katalog ------------------------------ */
    def({
      name: 'search_products', scope: SCOPES.catalog, risk: 'read',
      description: 'Vyhledá produkty podle textu a/nebo kategorie. Vrací jen základní údaje (bez ceny a skladu – ty zjistěte get_price/check_stock).',
      input: z.object({ query: z.string().max(200).optional(), category: z.string().max(60).optional(), limit: z.number().int().min(1).max(25).default(10) }).strict(),
      handler: async (ctx, i) => {
        const rows = await searchProducts(ctx.db, i);
        return { data: { count: rows.length, products: rows }, sources: rows.map((r: any) => src('catalog', `product:${r.sku}`)) };
      },
    }),
    def({
      name: 'get_product', scope: SCOPES.catalog, risk: 'read',
      description: 'Detail produktu včetně technických parametrů z katalogu (jediný zdroj technických parametrů).',
      input: z.object({ product: productRef }).strict(),
      handler: async (ctx, i) => {
        const p = await getProduct(ctx.db, i.product);
        return { data: p, sources: [src('catalog', `product:${p.sku}`)], entity: { type: 'product', id: p.id } };
      },
    }),
    def({
      name: 'get_price', scope: SCOPES.catalog, risk: 'read',
      description: 'Aktuální platná cena produktu z ceníku (bez DPH i s DPH). Ceny nikdy neuvádějte z paměti.',
      input: z.object({ product: productRef, price_list: z.string().max(30).default('retail') }).strict(),
      handler: async (ctx, i) => {
        const p = await resolveProduct(ctx.db, i.product);
        const price = await getPrice(ctx.db, p.id, i.price_list);
        return { data: { product: { id: p.id, sku: p.sku, name: p.name, unit: p.unit }, ...price },
          sources: [src('pricing', `price:${p.sku}:${i.price_list}`, `platné od ${price.valid_from}`)] };
      },
    }),
    def({
      name: 'check_stock', scope: SCOPES.catalog, risk: 'read',
      description: 'Zkontroluje dostupnost na skladu pro požadované množství a vrátí nejbližší možný termín expedice dle systému. Termín není závazný slib.',
      input: z.object({ product: productRef, qty: z.number().positive().max(1_000_000).default(1) }).strict(),
      handler: async (ctx, i) => {
        const p = await resolveProduct(ctx.db, i.product);
        const s = await checkStock(ctx.db, p.id, i.qty, ctx.now());
        return { data: { product: { id: p.id, sku: p.sku, name: p.name, unit: p.unit }, ...s },
          sources: [src('stock', `stock:${p.sku}`, `stav k ${s.stock_updated_at}`)] };
      },
    }),

    /* ------------------------------ kalkulace ------------------------------ */
    def({
      name: 'calculate_material', scope: SCOPES.calc, risk: 'read',
      description: 'Spočítá potřebné množství materiálu pro plochu v m² podle kalkulačních pravidel v DB (včetně ztrát a zaokrouhlení na balení).',
      input: z.object({ product: productRef, area_m2: z.number().positive().max(100000) }).strict(),
      handler: async (ctx, i) => {
        const d = await calculateMaterial(ctx.db, i.product, i.area_m2);
        return { data: d, sources: [src('calculator', `calc_rule:${d.product.sku}`), ...(d.price_available ? [src('pricing', `price:${d.product.sku}:retail`)] : [])] };
      },
    }),
    def({
      name: 'calculate_accessories', scope: SCOPES.calc, risk: 'read',
      description: 'Spočítá doporučené příslušenství k produktu (podle pravidel v DB). Podle pravidla vyžaduje area_m2 a/nebo quantity hlavního produktu.',
      input: z.object({ product: productRef, area_m2: z.number().positive().max(100000).optional(), quantity: z.number().positive().max(1_000_000).optional() }).strict()
        .refine((v) => v.area_m2 != null || v.quantity != null, 'Zadejte area_m2 nebo quantity'),
      handler: async (ctx, i) => {
        const d = await calculateAccessories(ctx.db, i.product, i);
        return { data: d, sources: [src('calculator', `accessory_rules:${d.main_product.sku}`)] };
      },
    }),
    def({
      name: 'calculate_shipping', scope: SCOPES.calc, risk: 'read',
      description: 'Orientační cena dopravy podle hmotnosti zásilky a PSČ z ceníku dopravy v DB.',
      input: z.object({ items: z.array(quoteItem).min(1).max(50), postal_code: postal }).strict(),
      handler: async (ctx, i) => {
        const d = await calculateShipping(ctx.db, i.items, i.postal_code);
        return { data: d, sources: [src('shipping', `zone:${d.zone}`)] };
      },
    }),

    /* -------------------------------- CRM -------------------------------- */
    def({
      name: 'create_customer', scope: SCOPES.crm, risk: 'write',
      description: 'Vytvoří zákazníka (pokud e-mail už existuje, vrátí existujícího – nic nepřepisuje). Uvádějte jen údaje, které zákazník sám sdělil.',
      input: z.object({
        type: z.enum(['person', 'company']).default('person'), name: z.string().min(2).max(120), company_name: z.string().max(160).optional(),
        ico: z.string().regex(/^\d{8}$/).optional(), email: z.string().email().max(160).optional(), phone: z.string().regex(/^\+?[\d\s-]{9,16}$/).optional(),
        street: z.string().max(160).optional(), city: z.string().max(100).optional(), postal_code: postal.optional(),
        consent_marketing: z.boolean().default(false), note: z.string().max(1000).optional(),
      }).strict().refine((v) => v.email || v.phone, 'Je nutný e-mail nebo telefon'),
      guard: async (ctx) => {
        if (ctx.actor.type !== 'ai') return { decision: 'allow' };
        const max = Number(await ctx.policy.get('customer.ai_create_per_hour', 20));
        const r = await ctx.db.query<any>(`select count(*)::int n from customers where created_by like 'ai:%' and created_at > now() - interval '1 hour'`);
        return r[0].n >= max ? { decision: 'deny', code: 'rate_limited', message: 'Překročen limit vytváření zákazníků' } : { decision: 'allow' };
      },
      handler: async (ctx, i) => {
        const r = await crm.createCustomer(ctx.db, i, ctx.actor);
        return { data: r, entity: { type: 'customer', id: r.customer_id } };
      },
    }),
    def({
      name: 'create_lead', scope: SCOPES.crm, risk: 'write',
      description: 'Vytvoří lead u existujícího zákazníka. Skóre kvalifikace se počítá serverem z uvedených údajů (qualification), nelze ho zadat.',
      input: z.object({ customer_id: uuid, summary: z.string().min(3).max(2000), source: z.enum(['web_ai', 'email', 'phone', 'manual', 'outbound']).default('web_ai'), qualification: qualification.default({}) }).strict(),
      handler: async (ctx, i) => {
        const r = await crm.createLead(ctx.db, { ...i, conversation_id: ctx.conversationId }, ctx.actor);
        return { data: r, entity: { type: 'lead', id: r.lead_id } };
      },
    }),
    def({
      name: 'update_lead', scope: SCOPES.crm, risk: 'write',
      description: 'Aktualizuje lead (stav, shrnutí, kvalifikační údaje). Stav "qualified" vyžaduje dostatečné skóre; "won"/"lost" vyžadují schválení člověka.',
      input: z.object({ lead_id: uuid, status: z.enum(['new', 'contacted', 'qualified', 'nurturing', 'won', 'lost']).optional(), summary: z.string().max(2000).optional(), qualification: qualification.optional() }).strict(),
      guard: async (ctx, i) => {
        if (ctx.actor.type === 'ai' && (i.status === 'won' || i.status === 'lost')) {
          return { decision: 'approval', category: 'status_change', summary: `Uzavření leadu ${i.lead_id} jako ${i.status}`, reason: 'Uzavření obchodní příležitosti rozhoduje člověk.' };
        }
        return { decision: 'allow' };
      },
      handler: async (ctx, i) => {
        const r = await crm.updateLead(ctx.db, ctx.policy, i);
        return { data: r, entity: { type: 'lead', id: r.lead_id } };
      },
    }),
    def({
      name: 'create_project', scope: SCOPES.crm, risk: 'write',
      description: 'Vytvoří CRM projekt (zakázku) pro zákazníka. Hodnota projektu se odvozuje z nabídek.',
      input: z.object({ customer_id: uuid, lead_id: uuid.optional(), name: z.string().min(3).max(160), project_type: z.string().min(2).max(60).default('other'), area_m2: z.number().positive().max(100000).optional(), postal_code: postal.optional(), notes: z.string().max(2000).optional() }).strict(),
      handler: async (ctx, i) => {
        const r = await crm.createProject(ctx.db, i, ctx.actor);
        return { data: r, entity: { type: 'project', id: r.project_id } };
      },
    }),
    def({
      name: 'update_project', scope: SCOPES.crm, risk: 'write',
      description: 'Aktualizuje projekt. Stavy "won"/"lost" vyžadují schválení člověka.',
      input: z.object({ project_id: uuid, name: z.string().min(3).max(160).optional(), status: z.enum(['draft', 'calculating', 'quoted', 'negotiation', 'won', 'lost', 'on_hold']).optional(), area_m2: z.number().positive().max(100000).optional(), postal_code: postal.optional(), notes: z.string().max(2000).optional() }).strict(),
      guard: async (ctx, i) => (ctx.actor.type === 'ai' && (i.status === 'won' || i.status === 'lost'))
        ? { decision: 'approval', category: 'status_change', summary: `Uzavření projektu ${i.project_id} jako ${i.status}`, reason: 'Uzavření zakázky rozhoduje člověk.' }
        : { decision: 'allow' },
      handler: async (ctx, i) => {
        const r = await crm.updateProject(ctx.db, i);
        return { data: r, entity: { type: 'project', id: r.project_id } };
      },
    }),

    /* ------------------------------- nabídky ------------------------------- */
    def({
      name: 'create_quote', scope: SCOPES.quote, risk: 'sensitive',
      description: 'Vytvoří NÁVRH nabídky. Ceny, sklad a dopravu doplní systém z DB – cenu zadat nelze. Sleva, vlastní podmínky, dřívější termín než možný či vysoká hodnota vyžadují schválení člověka.',
      input: z.object({
        customer_id: uuid, project_id: uuid.optional(), items: z.array(quoteItem).min(1).max(50), shipping_postal_code: postal.optional(),
        discount_pct: z.number().min(0).max(100).default(0), requested_delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        custom_terms: z.string().max(2000).optional(), notes: z.string().max(2000).optional(),
      }).strict(),
      guard: async (ctx, i) => {
        if (ctx.actor.type !== 'ai') return { decision: 'allow' };
        const { reasons } = await crm.assessQuoteRisk(ctx.db, ctx.policy, { items: i.items, shipping_postal_code: i.shipping_postal_code,
          discount_pct: i.discount_pct, requested_delivery_date: i.requested_delivery_date, custom_terms: i.custom_terms }, ctx.now());
        if (!reasons.length) return { decision: 'allow' };
        return { decision: 'approval', category: reasons[0].category, summary: `Nabídka pro zákazníka ${i.customer_id}: ${reasons.map((r) => r.text).join('; ')}`,
          reason: 'Nestandardní nabídka mimo pravomoc AI.' };
      },
      handler: async (ctx, i) => {
        const r = await crm.createQuote(ctx.db, ctx.policy, i, ctx.actor, ctx.now());
        return { data: r, entity: { type: 'quote', id: r.quote_id }, sources: [src('pricing', 'quote_pricing'), src('stock', 'quote_stock')] };
      },
    }),
    def({
      name: 'update_quote', scope: SCOPES.quote, risk: 'sensitive',
      description: 'Upraví návrh nabídky (položky, doprava, poznámky, stav draft/ready). Stavy sent/accepted/rejected nastavuje jen člověk. Stejná schvalovací pravidla jako create_quote.',
      input: z.object({
        quote_id: uuid, items: z.array(quoteItem).min(1).max(50).optional(), shipping_postal_code: postal.optional(),
        discount_pct: z.number().min(0).max(100).optional(), requested_delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        custom_terms: z.string().max(2000).optional(), notes: z.string().max(2000).optional(), status: z.enum(['draft', 'ready', 'sent', 'accepted', 'rejected']).optional(),
      }).strict(),
      guard: async (ctx, i) => {
        if (ctx.actor.type !== 'ai') return { decision: 'allow' };
        const q = await crm.requireQuote(ctx.db, i.quote_id);
        if (i.status && ['sent', 'accepted', 'rejected'].includes(i.status)) return { decision: 'deny', code: 'status_not_allowed', message: `AI nesmí nastavit stav ${i.status}` };
        if (['sent', 'accepted'].includes(q.status)) return { decision: 'deny', code: 'quote_locked', message: 'Odeslanou/přijatou nabídku AI upravovat nesmí' };
        const items = i.items ?? await crm.quoteItemsAsInput(ctx.db, q.id);
        const { reasons } = await crm.assessQuoteRisk(ctx.db, ctx.policy, {
          items, shipping_postal_code: i.shipping_postal_code, discount_pct: i.discount_pct ?? num(q.discount_pct),
          requested_delivery_date: i.requested_delivery_date ?? (q.requested_delivery_date ? dateStr(q.requested_delivery_date) : null),
          custom_terms: i.custom_terms ?? q.custom_terms }, ctx.now());
        if (!reasons.length) return { decision: 'allow' };
        return { decision: 'approval', category: reasons[0].category, summary: `Úprava nabídky ${q.number}: ${reasons.map((r) => r.text).join('; ')}`, reason: 'Nestandardní úprava mimo pravomoc AI.' };
      },
      handler: async (ctx, i) => {
        const r = await crm.updateQuote(ctx.db, ctx.policy, i, ctx.now());
        return { data: r, entity: { type: 'quote', id: r.quote_id } };
      },
    }),

    /* --------------------------- e-mail a follow-up --------------------------- */
    def({
      name: 'send_email', scope: SCOPES.email, risk: 'sensitive',
      description: 'Připraví/odešle e-mail ZÁKAZNÍKOVI z CRM (adresu nelze zadat ručně – bere se ze záznamu zákazníka). Dle politiky vyžaduje schválení člověkem. Žádné hromadné rozesílání.',
      input: z.object({
        customer_id: uuid, subject: z.string().min(3).max(200), body: z.string().min(10).max(8000),
        purpose: z.enum(['quote_delivery', 'followup', 'answer', 'other']).default('other'), quote_id: uuid.optional(), followup_id: uuid.optional(),
        attach_quote_pdf: z.boolean().optional().describe('Přiloží PDF nabídky quote_id'),
      }).strict(),
      guard: async (ctx, i) => {
        const c = await crm.requireCustomer(ctx.db, i.customer_id);
        if (i.attach_quote_pdf) {
          if (!i.quote_id) return { decision: 'deny', code: 'no_quote', message: 'Pro přílohu PDF je nutné quote_id' };
          const qq = await ctx.db.query<any>('select customer_id from quotes where id=$1', [i.quote_id]);
          if (!qq.length || qq[0].customer_id !== i.customer_id) return { decision: 'deny', code: 'quote_mismatch', message: 'Nabídka nepatří tomuto zákazníkovi' };
        }
        if (!c.email) return { decision: 'deny', code: 'no_recipient', message: 'Zákazník nemá e-mail' };
        if (ctx.actor.type !== 'ai') return { decision: 'allow' };
        const limit = Number(await ctx.policy.get('email.daily_limit', 50));
        if (await dailyAiEmailCount(ctx.db) >= limit) return { decision: 'deny', code: 'daily_limit', message: 'Překročen denní limit e-mailů' };
        if (await ctx.policy.get('email.ai_auto_send', false) !== true) {
          return { decision: 'approval', category: 'email', summary: `E-mail zákazníkovi (${i.purpose}): ${i.subject}`, reason: 'Odesílání e-mailů AI vyžaduje schválení (politika email.ai_auto_send).' };
        }
        return { decision: 'allow' };
      },
      handler: async (ctx, i) => {
        const c = await crm.requireCustomer(ctx.db, i.customer_id);
        const transport = ctx.deps.emailTransport as { name: string; send(m: any): Promise<void> };
        const ins = await ctx.db.query<any>(
          `insert into email_outbox (customer_id, to_email, subject, body, purpose, quote_id, followup_id, status, transport, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9) returning id`,
          [i.customer_id, c.email, i.subject, i.body, i.purpose, i.quote_id ?? null, i.followup_id ?? null, transport.name, ctx.actor.id]);
        const id = ins[0].id as string;
        let attachments: EmailAttachment[] | undefined;
        if (i.attach_quote_pdf && i.quote_id) {
          const pdf = await renderQuotePdf(ctx.db, ctx.policy, i.quote_id);
          attachments = [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }];
        }
        try {
          await transport.send({ to: c.email, subject: i.subject, body: i.body, ref: id, attachments });
          await ctx.db.query(`update email_outbox set status='sent', sent_at=now() where id=$1`, [id]);
          return { data: { email_id: id, status: 'sent', transport: transport.name }, entity: { type: 'email', id } };
        } catch {
          await ctx.db.query(`update email_outbox set status='failed', error='transport_error' where id=$1`, [id]);
          return { data: { email_id: id, status: 'failed', transport: transport.name }, entity: { type: 'email', id } };
        }
      },
    }),
    def({
      name: 'create_followup', scope: SCOPES.followup, risk: 'write',
      description: 'Naplánuje follow-up (e-mail/telefon/úkol) pro zákazníka. Termín max. 90 dní dopředu; počet otevřených follow-upů na zákazníka je omezený.',
      input: z.object({
        customer_id: uuid, lead_id: uuid.optional(), project_id: uuid.optional(), quote_id: uuid.optional(),
        due_in_days: z.number().int().min(0).max(365).optional(), due_at: z.string().datetime().optional(),
        channel: z.enum(['email', 'phone', 'task']).default('email'), purpose: z.string().min(3).max(300), note: z.string().max(1000).optional(),
      }).strict().refine((v) => v.due_in_days != null || v.due_at, 'Zadejte due_in_days nebo due_at'),
      guard: async (ctx, i) => {
        const due = crm.resolveDue(i, ctx.now());
        const maxDays = Number(await ctx.policy.get('followup.max_days_ahead', 90));
        if (due.getTime() < ctx.now().getTime() - 60_000) return { decision: 'deny', code: 'past_due', message: 'Termín follow-upu je v minulosti' };
        if (due.getTime() > ctx.now().getTime() + maxDays * 86_400_000) return { decision: 'deny', code: 'too_far', message: `Termín je dále než ${maxDays} dní` };
        const max = Number(await ctx.policy.get('followup.max_pending_per_customer', 5));
        const r = await ctx.db.query<any>(`select count(*)::int n from followups where customer_id=$1 and status='pending'`, [i.customer_id]);
        if (r[0].n >= max) return { decision: 'deny', code: 'too_many_followups', message: 'Zákazník už má maximum otevřených follow-upů' };
        return { decision: 'allow' };
      },
      handler: async (ctx, i) => {
        const r = await crm.createFollowup(ctx.db, i, ctx.actor, ctx.now());
        return { data: r, entity: { type: 'followup', id: r.followup_id } };
      },
    }),

    /* ------------------------------ schvalování ------------------------------ */
    def({
      name: 'request_human_approval', scope: SCOPES.approval, risk: 'write',
      description: 'POVINNĚ použít, když zákazník chce: změnu ceny, nestandardní slevu, změnu obchodních podmínek, potvrzení nestandardního termínu, řeší právní spor nebo reklamaci s vysokou hodnotou, nebo si nejste jistí. Předá věc člověku; AI nic neslibuje.',
      input: z.object({
        category: z.enum(['price_change', 'discount', 'terms', 'delivery_date', 'legal', 'complaint', 'other']),
        summary: z.string().min(5).max(500), reason: z.string().min(3).max(1000),
        customer_id: uuid.optional(), lead_id: uuid.optional(), project_id: uuid.optional(), quote_id: uuid.optional(),
      }).strict(),
      handler: async (ctx, i) => {
        const approvals = ctx.deps.approvals as { create: (db: any, a: any) => Promise<{ id: string }> };
        const a = await approvals.create(ctx.db, { category: i.category, summary: i.summary, reason: i.reason,
          input: { customer_id: i.customer_id, lead_id: i.lead_id, project_id: i.project_id, quote_id: i.quote_id }, actor: ctx.actor, conversationId: ctx.conversationId });
        return { data: { approval_id: a.id, status: 'pending', message: 'Žádost předána obchodníkovi. Zákazníkovi nic neslibujte.' }, entity: { type: 'approval', id: a.id } };
      },
    }),


    /* ----------------------- aktivní vyhledávání zakázek ----------------------- */
    def({
      name: 'create_opportunity', scope: SCOPES.scout, risk: 'write',
      description: 'Uloží nalezenou příležitost (zakázku s fasádou z obkladových pásků nebo lícových cihel). POVINNÁ je doslovná citace ze stránky, která fasádu dokládá. Kontakt, který na stránce není, nelze uvést. Skóre počítá server.',
      input: z.object({
        url: z.string().url().max(1000), title: z.string().min(3).max(300), organization: z.string().max(200).optional(),
        location: z.string().max(200).optional(), region: z.string().max(60).optional(),
        stage: z.enum(['tender', 'planning', 'construction', 'completed', 'unknown']).default('unknown'),
        facade_material: z.enum(['brick_slips', 'facing_brick', 'other']),
        scale_note: z.string().max(300).optional().describe('Rozsah jen pokud je ve zdroji (např. plocha fasády)'),
        evidence: z.string().min(20).max(600).describe('DOSLOVNÁ citace ze stránky dokládající fasádu z pásků/lícových cihel'),
        contact_email: z.string().email().max(160).optional(), contact_phone: z.string().max(40).optional(), contact_name: z.string().max(120).optional(),
        draft_subject: z.string().min(3).max(200).optional(), draft_body: z.string().min(20).max(1500).optional(),
      }).strict(),
      guard: async (ctx, i) => {
        const pages = ctx.deps.scoutPages as Map<string, string> | undefined;
        let key: string; try { key = urlKey(i.url); } catch { return { decision: 'deny', code: 'bad_url', message: 'Neplatná URL' }; }
        const text = pages?.get(key);
        if (text === undefined) return { decision: 'deny', code: 'not_fetched', message: 'Stránka nebyla v tomto běhu stažena – příležitost nelze uložit' };
        if (!normQuote(text).includes(normQuote(i.evidence))) return { decision: 'deny', code: 'evidence_not_found', message: 'Citace není doslovně ve stránce' };
        const nt = normQuote(text);
        if (i.contact_email && !nt.includes(normQuote(i.contact_email))) return { decision: 'deny', code: 'contact_not_in_source', message: 'E-mail není na stránce' };
        if (i.contact_phone && !nt.replace(/[\s-]/g, '').includes(i.contact_phone.replace(/[\s-]/g, ''))) return { decision: 'deny', code: 'contact_not_in_source', message: 'Telefon není na stránce' };
        if (i.contact_name && !nt.includes(normQuote(i.contact_name))) return { decision: 'deny', code: 'contact_not_in_source', message: 'Jméno není na stránce' };
        if ((i.draft_subject || i.draft_body) && !(i.draft_subject && i.draft_body)) return { decision: 'deny', code: 'draft_incomplete', message: 'Návrh e-mailu vyžaduje předmět i text' };
        if (i.draft_body && !i.contact_email) return { decision: 'deny', code: 'draft_without_contact', message: 'Návrh e-mailu je možný jen s nalezeným kontaktním e-mailem' };
        if (`${i.draft_subject ?? ''} ${i.draft_body ?? ''}`.match(/\d[\d\s.,]*\s*(Kč|CZK|€|EUR|%|korun)/i)) return { decision: 'deny', code: 'draft_has_prices', message: 'Návrh e-mailu nesmí obsahovat ceny, slevy ani čísla s měnou' };
        return { decision: 'allow' };
      },
      handler: async (ctx, i): Promise<{ data: { opportunity_id: string; fit_score?: number; duplicate: boolean }; entity: { type: string; id: string }; sources?: any[] }> => {
        const key = urlKey(i.url); const text = (ctx.deps.scoutPages as Map<string, string>).get(key)!;
        const hits = csv(await ctx.policy.get('scout.facade_keywords', '')).filter((k) => hasFacadeKeyword(text, [k])).length;
        const score = scoreOpportunity({ facade_material: i.facade_material, stage: i.stage, scale_note: i.scale_note, region: i.region, has_contact: !!(i.contact_email || i.contact_phone), keyword_hits: hits });
        const ex = await ctx.db.query<any>('select id from opportunities where url_key=$1', [key]);
        if (ex.length) return { data: { opportunity_id: ex[0].id, duplicate: true }, entity: { type: 'opportunity', id: ex[0].id } };
        const r = await ctx.db.query<any>(
          `insert into opportunities (url, url_key, title, organization, location, region, stage, facade_material, scale_note, evidence, fit_score,
             contact_email, contact_phone, contact_name, draft_subject, draft_body, run_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
          [i.url, key, i.title, i.organization ?? null, i.location ?? null, i.region ?? null, i.stage, i.facade_material, i.scale_note ?? null, i.evidence, score,
           i.contact_email ?? null, i.contact_phone ?? null, i.contact_name ?? null, i.draft_subject ?? null, i.draft_body ?? null,
           /^[0-9a-f-]{36}$/i.test(ctx.requestId) ? ctx.requestId : null]);
        return { data: { opportunity_id: r[0].id, fit_score: score, duplicate: false }, entity: { type: 'opportunity', id: r[0].id }, sources: [src('web', i.url)] };
      },
    }),

    /* ----------------------------- znalostní báze ----------------------------- */
    def({
      name: 'search_knowledge', scope: SCOPES.kb, risk: 'read',
      description: 'Vyhledá v technické dokumentaci a znalostní bázi (montážní postupy, normy, dodací podmínky). Odpovídejte jen na základě nalezených pasáží a uveďte zdroj.',
      input: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(8).default(4) }).strict(),
      handler: async (ctx, i) => {
        const hits = await knowledge.search(ctx.db, i.query, i.limit);
        return { data: { count: hits.length, passages: hits.map((h) => ({ title: h.title, ref: `${h.document_id}#${h.ord}`, text: h.content, score: h.score })) },
          sources: hits.map((h) => src('knowledge_base', `${h.title}#${h.ord}`)) };
      },
    }),
  ];
}
export { DomainError, isoDate };
