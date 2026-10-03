import { DomainError, type Db, type PolicyReader, type Actor } from '../ai-core/index.js';
import { checkStock, getPrice, resolveProduct } from './catalog.js';
import { calculateShipping } from './calc.js';
import { addDays, isoDate, num, round2 } from './util.js';

/* ------------------------------ zákazníci ------------------------------ */
export interface CustomerInput {
  type: 'person' | 'company'; name: string; company_name?: string; ico?: string; email?: string; phone?: string;
  street?: string; city?: string; postal_code?: string; consent_marketing?: boolean; note?: string;
}
export async function createCustomer(db: Db, i: CustomerInput, actor: Actor) {
  if (i.email) {
    const ex = await db.query<any>('select id from customers where lower(email)=lower($1)', [i.email]);
    if (ex.length) return { customer_id: ex[0].id as string, created: false };
  }
  const r = await db.query<any>(
    `insert into customers (type,name,company_name,ico,email,phone,street,city,postal_code,consent_marketing,note,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [i.type, i.name, i.company_name ?? null, i.ico ?? null, i.email ?? null, i.phone ?? null, i.street ?? null,
     i.city ?? null, i.postal_code ?? null, i.consent_marketing ?? false, i.note ?? null, actor.id]);
  return { customer_id: r[0].id as string, created: true };
}
export async function requireCustomer(db: Db, id: string) {
  const r = await db.query<any>('select * from customers where id=$1', [id]);
  if (!r.length) throw new DomainError('customer_not_found', 'Zákazník neexistuje');
  return r[0];
}

/* -------------------------------- leady -------------------------------- */
export interface Qualification {
  project_type?: string; area_m2?: number; timeline?: 'asap' | '1_month' | '3_months' | 'later' | 'unknown';
  budget_net?: number; postal_code?: string; is_decision_maker?: boolean; notes?: string;
}
/** Deterministické skóre 0–100 (ne LLM). */
export function scoreLead(customer: { email?: string | null; phone?: string | null }, q: Qualification): number {
  let s = 0;
  if (customer.email || customer.phone) s += 20;
  if (q.area_m2 && q.area_m2 > 0) s += 20;
  s += ({ asap: 20, '1_month': 20, '3_months': 10, later: 3, unknown: 0 } as Record<string, number>)[q.timeline ?? 'unknown'];
  if (q.budget_net && q.budget_net > 0) s += 15;
  if (q.postal_code) s += 10;
  if (q.project_type) s += 10;
  if (q.is_decision_maker) s += 5;
  return Math.min(100, s);
}
export async function requireLead(db: Db, id: string) {
  const r = await db.query<any>('select * from leads where id=$1', [id]);
  if (!r.length) throw new DomainError('lead_not_found', 'Lead neexistuje');
  return r[0];
}
export async function createLead(db: Db, i: { customer_id: string; summary: string; source: string; qualification: Qualification; conversation_id?: string }, actor: Actor) {
  const c = await requireCustomer(db, i.customer_id);
  const score = scoreLead(c, i.qualification);
  const r = await db.query<any>(
    `insert into leads (customer_id, source, status, score, qualification, summary, conversation_id, created_by)
     values ($1,$2,'new',$3,$4,$5,$6,$7) returning id`,
    [i.customer_id, i.source, score, JSON.stringify(i.qualification), i.summary, i.conversation_id ?? null, actor.id]);
  return { lead_id: r[0].id as string, status: 'new', score };
}
export async function updateLead(db: Db, policy: PolicyReader, i: { lead_id: string; status?: string; summary?: string; qualification?: Qualification }) {
  const lead = await requireLead(db, i.lead_id);
  const c = await requireCustomer(db, lead.customer_id);
  const q = { ...lead.qualification, ...(i.qualification ?? {}) };
  const score = scoreLead(c, q);
  if (i.status === 'qualified') {
    const min = Number(await policy.get('lead.qualify_min_score', 60));
    if (score < min) throw new DomainError('not_qualified', `Skóre ${score} je pod hranicí ${min} – lead nelze označit jako kvalifikovaný`);
  }
  await db.query(
    `update leads set status=coalesce($2,status), summary=coalesce($3,summary), qualification=$4, score=$5, updated_at=now() where id=$1`,
    [i.lead_id, i.status ?? null, i.summary ?? null, JSON.stringify(q), score]);
  return { lead_id: i.lead_id, status: i.status ?? lead.status, score };
}

/* ------------------------------- projekty ------------------------------- */
export async function requireProject(db: Db, id: string) {
  const r = await db.query<any>('select * from projects where id=$1', [id]);
  if (!r.length) throw new DomainError('project_not_found', 'Projekt neexistuje');
  return r[0];
}
export async function createProject(db: Db, i: { customer_id: string; lead_id?: string; name: string; project_type: string; area_m2?: number; postal_code?: string; notes?: string }, actor: Actor) {
  await requireCustomer(db, i.customer_id);
  if (i.lead_id) { const l = await requireLead(db, i.lead_id); if (l.customer_id !== i.customer_id) throw new DomainError('mismatch', 'Lead patří jinému zákazníkovi'); }
  const r = await db.query<any>(
    `insert into projects (customer_id, lead_id, name, project_type, area_m2, postal_code, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [i.customer_id, i.lead_id ?? null, i.name, i.project_type, i.area_m2 ?? null, i.postal_code ?? null, i.notes ?? '', actor.id]);
  return { project_id: r[0].id as string, status: 'draft' };
}
export async function updateProject(db: Db, i: { project_id: string; name?: string; status?: string; area_m2?: number; postal_code?: string; notes?: string }) {
  const p = await requireProject(db, i.project_id);
  await db.query(
    `update projects set name=coalesce($2,name), status=coalesce($3,status), area_m2=coalesce($4,area_m2),
       postal_code=coalesce($5,postal_code), notes=coalesce($6,notes), updated_at=now() where id=$1`,
    [i.project_id, i.name ?? null, i.status ?? null, i.area_m2 ?? null, i.postal_code ?? null, i.notes ?? null]);
  return { project_id: i.project_id, status: i.status ?? p.status };
}
/** Hodnota projektu se odvozuje z nabídek (ne z údajů od AI). */
export async function recomputeProjectValue(db: Db, projectId: string) {
  const r = await db.query<any>(
    `select total_net from quotes where project_id=$1 and status not in ('rejected','expired') order by created_at desc limit 1`, [projectId]);
  await db.query(
    `update projects set estimated_value_net=$2, updated_at=now(),
       status = case when status in ('draft','calculating') and $3 then 'quoted' else status end where id=$1`,
    [projectId, r.length ? num(r[0].total_net) : 0, r.length > 0]);
}

/* -------------------------------- nabídky -------------------------------- */
export interface QuoteItemInput { product: string; qty: number }
export interface QuoteInput {
  customer_id: string; project_id?: string; items: QuoteItemInput[]; shipping_postal_code?: string;
  discount_pct?: number; requested_delivery_date?: string; custom_terms?: string; notes?: string;
}
export interface PricedQuote {
  lines: Array<{ product_id: string; sku: string; name: string; unit: string; qty: number; unit_price_net: number; vat_rate: number; line_net: number }>;
  subtotal_net: number; discount_pct: number; discount_net: number; shipping_net: number; shipping_vat_rate: number;
  total_net: number; total_vat: number; total_gross: number; currency: string;
  earliest_delivery_date: string; stock_warnings: string[];
}
/** Ceny, sklad a doprava VŽDY z DB. */
export async function priceQuote(db: Db, policy: PolicyReader, i: Pick<QuoteInput, 'items' | 'shipping_postal_code' | 'discount_pct'>, today = new Date()): Promise<PricedQuote> {
  const vatDefault = Number(await policy.get('vat.default_rate', 21));
  const lines: PricedQuote['lines'] = []; const warnings: string[] = []; let earliest = isoDate(today); let currency = 'CZK';
  for (const it of i.items) {
    const p = await resolveProduct(db, it.product);
    const price = await getPrice(db, p.id);
    currency = price.currency;
    const st = await checkStock(db, p.id, it.qty, today);
    if (!st.in_stock) warnings.push(`${p.sku}: není skladem v plném množství (chybí ${st.shortfall} ${p.unit}), dodání dle zdroje nejdříve ${st.earliest_dispatch_date}`);
    if (st.earliest_dispatch_date > earliest) earliest = st.earliest_dispatch_date;
    lines.push({ product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, qty: it.qty, unit_price_net: price.amount_net,
      vat_rate: price.vat_rate, line_net: round2(it.qty * price.amount_net) });
  }
  const subtotal = round2(lines.reduce((a, l) => a + l.line_net, 0));
  const discountPct = i.discount_pct ?? 0;
  const factor = 1 - discountPct / 100;
  const discountNet = round2(subtotal * (discountPct / 100));
  let shipping = 0;
  if (i.shipping_postal_code) {
    const s = await calculateShipping(db, i.items.map((x) => ({ product: x.product, qty: x.qty })), i.shipping_postal_code);
    shipping = s.price_net;
  }
  const vat = round2(lines.reduce((a, l) => a + l.line_net * factor * (l.vat_rate / 100), 0) + shipping * (vatDefault / 100));
  const total = round2(subtotal - discountNet + shipping);
  return { lines, subtotal_net: subtotal, discount_pct: discountPct, discount_net: discountNet, shipping_net: shipping,
    shipping_vat_rate: vatDefault, total_net: total, total_vat: vat, total_gross: round2(total + vat), currency,
    earliest_delivery_date: earliest, stock_warnings: warnings };
}

async function writeItems(db: Db, quoteId: string, priced: PricedQuote) {
  await db.query('delete from quote_items where quote_id=$1', [quoteId]);
  for (const l of priced.lines) {
    await db.query(
      `insert into quote_items (quote_id, product_id, sku, name, unit, qty, unit_price_net, vat_rate, line_net) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [quoteId, l.product_id, l.sku, l.name, l.unit, l.qty, l.unit_price_net, l.vat_rate, l.line_net]);
  }
}

export async function createQuote(db: Db, policy: PolicyReader, i: QuoteInput, actor: Actor, today = new Date()) {
  await requireCustomer(db, i.customer_id);
  if (i.project_id) { const p = await requireProject(db, i.project_id); if (p.customer_id !== i.customer_id) throw new DomainError('mismatch', 'Projekt patří jinému zákazníkovi'); }
  const priced = await priceQuote(db, policy, i, today);
  const validDays = Number(await policy.get('quote.valid_days', 14));
  const year = today.getUTCFullYear();
  const seq = (await db.query<any>(
    'insert into quote_counters (year, last) values ($1, 1) on conflict (year) do update set last = quote_counters.last + 1 returning last', [year]))[0].last;
  const number = `N-${year}-${String(seq).padStart(4, '0')}`;
  const r = await db.query<any>(
    `insert into quotes (number, project_id, customer_id, status, currency, discount_pct, total_net, total_vat, total_gross, shipping_net,
       valid_until, earliest_delivery_date, requested_delivery_date, custom_terms, notes, created_by)
     values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [number, i.project_id ?? null, i.customer_id, priced.currency, priced.discount_pct, priced.total_net, priced.total_vat,
     priced.total_gross, priced.shipping_net, isoDate(addDays(today, validDays)), priced.earliest_delivery_date,
     i.requested_delivery_date ?? null, i.custom_terms ?? null, i.notes ?? '', actor.id]);
  const id = r[0].id as string;
  await writeItems(db, id, priced);
  if (i.project_id) await recomputeProjectValue(db, i.project_id);
  return { quote_id: id, number, status: 'draft', ...summarize(priced) };
}

export async function requireQuote(db: Db, id: string) {
  const r = await db.query<any>('select * from quotes where id=$1', [id]);
  if (!r.length) throw new DomainError('quote_not_found', 'Nabídka neexistuje');
  return r[0];
}
export async function quoteItemsAsInput(db: Db, quoteId: string): Promise<QuoteItemInput[]> {
  const rows = await db.query<any>('select sku, qty from quote_items where quote_id=$1', [quoteId]);
  return rows.map((r) => ({ product: r.sku, qty: num(r.qty) }));
}

export interface QuoteUpdate {
  quote_id: string; items?: QuoteItemInput[]; shipping_postal_code?: string; discount_pct?: number;
  requested_delivery_date?: string; custom_terms?: string; notes?: string; status?: 'draft' | 'ready' | 'sent' | 'accepted' | 'rejected';
}
export async function updateQuote(db: Db, policy: PolicyReader, i: QuoteUpdate, today = new Date()) {
  const q = await requireQuote(db, i.quote_id);
  const needsReprice = i.items || i.discount_pct !== undefined || i.shipping_postal_code !== undefined;
  let summary: ReturnType<typeof summarize> | undefined;
  if (needsReprice) {
    const items = i.items ?? (await quoteItemsAsInput(db, q.id));
    const priced = await priceQuote(db, policy, { items, discount_pct: i.discount_pct ?? num(q.discount_pct),
      shipping_postal_code: i.shipping_postal_code }, today);
    await db.query(
      `update quotes set discount_pct=$2, total_net=$3, total_vat=$4, total_gross=$5, shipping_net=$6, earliest_delivery_date=$7, updated_at=now() where id=$1`,
      [q.id, priced.discount_pct, priced.total_net, priced.total_vat, priced.total_gross, priced.shipping_net, priced.earliest_delivery_date]);
    await writeItems(db, q.id, priced);
    summary = summarize(priced);
  }
  await db.query(
    `update quotes set requested_delivery_date=coalesce($2,requested_delivery_date), custom_terms=coalesce($3,custom_terms),
       notes=coalesce($4,notes), status=coalesce($5,status), updated_at=now() where id=$1`,
    [q.id, i.requested_delivery_date ?? null, i.custom_terms ?? null, i.notes ?? null, i.status ?? null]);
  if (q.project_id) await recomputeProjectValue(db, q.project_id);
  return { quote_id: q.id, number: q.number as string, status: i.status ?? (q.status as string), ...(summary ?? {}) };
}

function summarize(p: PricedQuote) {
  return { lines: p.lines.length, subtotal_net: p.subtotal_net, discount_pct: p.discount_pct, shipping_net: p.shipping_net,
    total_net: p.total_net, total_vat: p.total_vat, total_gross: p.total_gross, currency: p.currency,
    earliest_delivery_date: p.earliest_delivery_date, stock_warnings: p.stock_warnings };
}

/** Rizikové okolnosti nabídky (společné pro create/update guard). */
export async function assessQuoteRisk(db: Db, policy: PolicyReader, merged: {
  items: QuoteItemInput[]; shipping_postal_code?: string; discount_pct: number; requested_delivery_date?: string | null; custom_terms?: string | null;
}, today = new Date()) {
  const reasons: Array<{ category: string; text: string }> = [];
  const maxDiscount = Number(await policy.get('discount.max_auto_pct', 0));
  if (merged.discount_pct > maxDiscount) reasons.push({ category: 'discount', text: `sleva ${merged.discount_pct} % (limit bez schválení ${maxDiscount} %)` });
  if (merged.custom_terms && merged.custom_terms.trim()) reasons.push({ category: 'terms', text: 'nestandardní obchodní podmínky' });
  const priced = await priceQuote(db, policy, merged, today);
  if (merged.requested_delivery_date && merged.requested_delivery_date < priced.earliest_delivery_date) {
    reasons.push({ category: 'delivery_date', text: `požadovaný termín ${merged.requested_delivery_date} je dříve než nejbližší možný ${priced.earliest_delivery_date}` });
  }
  const threshold = Number(await policy.get('quote.approval_threshold_net', 500000));
  if (priced.total_net > threshold) reasons.push({ category: 'quote_value', text: `hodnota ${priced.total_net} ${priced.currency} bez DPH přesahuje ${threshold}` });
  return { reasons, priced };
}

/* -------------------------------- follow-up -------------------------------- */
export interface FollowupInput {
  customer_id: string; lead_id?: string; project_id?: string; quote_id?: string;
  due_in_days?: number; due_at?: string; channel: 'email' | 'phone' | 'task'; purpose: string; note?: string;
}
export function resolveDue(i: Pick<FollowupInput, 'due_in_days' | 'due_at'>, now: Date): Date {
  if (i.due_at) { const d = new Date(i.due_at); if (isNaN(+d)) throw new DomainError('bad_date', 'Neplatné due_at'); return d; }
  if (i.due_in_days != null) return addDays(now, i.due_in_days);
  throw new DomainError('missing_due', 'Zadejte due_in_days nebo due_at');
}
export async function createFollowup(db: Db, i: FollowupInput, actor: Actor, now: Date) {
  await requireCustomer(db, i.customer_id);
  const due = resolveDue(i, now);
  const r = await db.query<any>(
    `insert into followups (customer_id, lead_id, project_id, quote_id, due_at, channel, purpose, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [i.customer_id, i.lead_id ?? null, i.project_id ?? null, i.quote_id ?? null, due.toISOString(), i.channel, i.purpose, i.note ?? '', actor.id]);
  return { followup_id: r[0].id as string, due_at: due.toISOString(), status: 'pending' };
}
