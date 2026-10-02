import { DomainError, type Db, type Source } from '../ai-core/index.js';
import { UUID_RE, addDays, dateStr, isoDate, norm, num, round2, round3 } from './util.js';

export const src = (system: string, ref: string, note?: string): Source => ({ system, ref, retrieved_at: new Date().toISOString(), note });

export async function resolveProduct(db: Db, ref: string) {
  const rows = await db.query<any>(
    UUID_RE.test(ref) ? 'select * from products where id=$1 and active' : 'select * from products where upper(sku)=upper($1) and active', [ref]);
  if (!rows.length) throw new DomainError('product_not_found', `Produkt "${ref}" neexistuje nebo není aktivní`);
  return rows[0];
}

export async function searchProducts(db: Db, q: { query?: string; category?: string; limit: number }) {
  const where = ['active']; const p: unknown[] = [];
  for (const raw of norm(q.query ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
    // jednoduchý "stemming" pro české koncovky: slova od 5 znaků zkrátíme o 2 (taška/tašku/tašky -> tas)
    const t = raw.length >= 5 ? raw.slice(0, raw.length - 2) : raw;
    p.push(`%${t.replace(/[%_\\]/g, '\\$&')}%`); where.push(`search_text like $${p.length}`);
  }
  if (q.category) { p.push(q.category); where.push(`category = $${p.length}`); }
  p.push(q.limit);
  return db.query<any>(
    `select id, sku, name, category, unit, left(description, 240) as description from products
     where ${where.join(' and ')} order by name limit $${p.length}`, p);
}

export async function getProduct(db: Db, ref: string) {
  const r = await resolveProduct(db, ref);
  return { id: r.id, sku: r.sku, name: r.name, description: r.description, category: r.category, unit: r.unit,
    weight_kg: num(r.weight_kg), attributes: r.attributes };
}

export async function getPrice(db: Db, productId: string, priceList = 'retail', onDate?: string) {
  const rows = await db.query<any>(
    `select amount_net, vat_rate, currency, valid_from, valid_to, price_list from prices
     where product_id=$1 and price_list=$2 and valid_from <= coalesce($3::date, current_date)
       and (valid_to is null or valid_to >= coalesce($3::date, current_date))
     order by valid_from desc limit 1`, [productId, priceList, onDate ?? null]);
  if (!rows.length) throw new DomainError('price_not_found', 'Pro produkt není platná cena – nelze ji uvádět zákazníkovi');
  const r = rows[0];
  const net = num(r.amount_net); const vat = num(r.vat_rate);
  return { price_list: r.price_list, amount_net: net, vat_rate: vat, amount_gross: round2(net * (1 + vat / 100)),
    currency: r.currency as string, valid_from: dateStr(r.valid_from) };
}

export async function checkStock(db: Db, productId: string, qty: number, today = new Date()) {
  const rows = await db.query<any>('select * from stock where product_id=$1', [productId]);
  if (!rows.length) throw new DomainError('stock_unknown', 'O skladu produktu nejsou data – dostupnost nelze potvrdit');
  const s = rows[0];
  const free = round3(num(s.qty_available) - num(s.qty_reserved));
  const inStock = free >= qty;
  const leadDays = Number(s.lead_time_days);
  const earliest = inStock ? isoDate(today)
    : s.restock_date && dateStr(s.restock_date) > isoDate(today) ? dateStr(s.restock_date)
    : isoDate(addDays(today, leadDays));
  return { requested_qty: qty, qty_free: free, in_stock: inStock, shortfall: inStock ? 0 : round3(qty - Math.max(free, 0)),
    lead_time_days: inStock ? 0 : leadDays, earliest_dispatch_date: earliest, stock_updated_at: new Date(s.updated_at).toISOString() };
}
