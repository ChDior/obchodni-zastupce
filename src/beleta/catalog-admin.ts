import { DomainError, type AuditLog, type Db } from '../ai-core/index.js';
import { HANDLERS } from './import-csv.js';
import { norm } from './util.js';

export async function listProducts(db: Db, search?: string, limit?: number, offset?: number) {
  const s = search?.trim() ? `%${norm(search).replace(/[%_\\]/g, '')}%` : null;
  return db.query(
    `select p.id, p.sku, p.name, p.category, p.unit, p.active,
       (select amount_net::float8 from prices where product_id=p.id and price_list='retail' and valid_from <= current_date and (valid_to is null or valid_to >= current_date) order by valid_from desc limit 1) as price_net,
       (select vat_rate::float8 from prices where product_id=p.id and price_list='retail' and valid_from <= current_date and (valid_to is null or valid_to >= current_date) order by valid_from desc limit 1) as vat_rate,
       s.qty_available::float8 as stock_qty
     from products p left join stock s on s.product_id=p.id
     ${s ? 'where p.search_text like $3' : ''} order by p.sku limit $1 offset $2`,
    s ? [Math.min(limit ?? 100, 500), offset ?? 0, s] : [Math.min(limit ?? 100, 500), offset ?? 0]);
}

export async function getProductAdmin(db: Db, id: string) {
  const p = (await db.query<any>('select id, sku, name, description, category, unit, weight_kg::float8 as weight_kg, attributes, active from products where id=$1', [id]))[0];
  if (!p) return null;
  return {
    product: p,
    prices: await db.query(`select price_list, amount_net::float8 as amount_net, vat_rate::float8 as vat_rate, currency, valid_from, valid_to from prices where product_id=$1 order by valid_from desc limit 20`, [id]),
    stock: (await db.query<any>(`select qty_available::float8 as qty_available, qty_reserved::float8 as qty_reserved, lead_time_days, restock_date, source, updated_at from stock where product_id=$1`, [id]))[0] ?? null,
    calc_rule: (await db.query<any>(`select consumption_per_m2::float8 as consumption_per_m2, waste_pct::float8 as waste_pct, pack_size::float8 as pack_size, pack_label, note from calc_rules where product_id=$1`, [id]))[0] ?? null,
    accessories: await db.query(`select a.basis, a.factor::float8 as factor, a.waste_pct::float8 as waste_pct, x.sku, x.name from accessory_rules a join products x on x.id=a.accessory_product_id where a.product_id=$1 order by x.sku`, [id]),
  };
}

export interface ProductEdit {
  sku?: string; name?: string; description?: string; category?: string; unit?: string; weight_kg?: number; active?: boolean;
  attributes?: Record<string, unknown>;
  price_net?: number; vat_rate?: number; currency?: string;
  stock_qty?: number; lead_time_days?: number; restock_date?: string;
  calc_rule?: { consumption_per_m2: number; waste_pct?: number; pack_size?: number; pack_label?: string; note?: string };
}

/** Vytvoření (id nezadáno, nutné sku, name, price_net) nebo úprava produktu. Vše v jedné transakci, stejná pravidla jako import CSV, s auditem. */
export async function saveProduct(db: Db, audit: AuditLog, id: string | null, e: ProductEdit, by: string): Promise<{ id: string; sku: string; result: string }> {
  return db.tx(async (t) => {
    let sku = e.sku;
    if (id) {
      const cur = (await t.query<any>('select sku from products where id=$1 for update', [id]))[0];
      if (!cur) throw new DomainError('not_found', 'Produkt neexistuje');
      if (e.sku && e.sku !== cur.sku) throw new DomainError('validation_error', 'SKU nelze měnit');
      sku = cur.sku;
    } else {
      if (!e.sku?.trim()) throw new DomainError('validation_error', 'Chybí SKU');
      sku = e.sku.trim();
      if ((await t.query('select 1 from products where sku=$1', [sku])).length) throw new DomainError('sku_exists', 'Produkt s tímto SKU už existuje');
    }
    const rec: Record<string, string> = { sku: sku! };
    for (const k of ['name', 'description', 'category', 'unit', 'weight_kg', 'active', 'price_net', 'vat_rate', 'currency', 'stock_qty', 'lead_time_days', 'restock_date'] as const) {
      if (e[k] !== undefined) rec[k] = String(e[k]);
    }
    const cols = Object.keys(rec);
    let result: string;
    try {
      result = await HANDLERS.products(t, (c) => rec[c], (c) => c in rec, cols);
      if (e.attributes) {
        if (typeof e.attributes !== 'object' || Array.isArray(e.attributes)) throw new Error('attributes musí být objekt');
        await t.query('update products set attributes=$2, updated_at=now() where sku=$1', [sku, JSON.stringify(e.attributes)]);
      }
      if (e.calc_rule) {
        const c = e.calc_rule; const r2: Record<string, string> = { sku: sku!, consumption_per_m2: String(c.consumption_per_m2) };
        if (c.waste_pct !== undefined) r2.waste_pct = String(c.waste_pct);
        if (c.pack_size !== undefined) r2.pack_size = String(c.pack_size);
        if (c.pack_label !== undefined) r2.pack_label = c.pack_label;
        if (c.note !== undefined) r2.note = c.note;
        await HANDLERS.calc_rules(t, (k) => r2[k], (k) => k in r2, Object.keys(r2));
      }
    } catch (err) { throw new DomainError('validation_error', (err as Error).message); }
    const pid = (await t.query<any>('select id from products where sku=$1', [sku]))[0].id as string;
    await audit.record(t, { actor_type: 'human', actor_id: by, action: id ? 'catalog.update' : 'catalog.create', status: 'success', entity_type: 'product', entity_id: pid,
      output: { sku, fields: [...cols.filter((c) => c !== 'sku'), ...(e.attributes ? ['attributes'] : []), ...(e.calc_rule ? ['calc_rule'] : [])],
        ...(e.price_net !== undefined ? { price_net: e.price_net } : {}), ...(e.stock_qty !== undefined ? { stock_qty: e.stock_qty } : {}) } });
    return { id: pid, sku: sku!, result };
  });
}
