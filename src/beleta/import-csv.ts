import { DomainError, type AuditLog, type Db } from '../ai-core/index.js';
import { norm } from './util.js';

export const IMPORT_TYPES = ['products', 'calc_rules', 'accessory_rules', 'shipping_zones', 'shipping_rates'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];
export interface ImportError { line: number; message: string }
export interface ImportResult { type: ImportType; dry_run: boolean; applied: boolean; created: number; updated: number; unchanged: number; errors: ImportError[] }

/** CSV parser (RFC 4180 + oddělovač ; nebo , podle hlavičky, BOM, uvozovky, víceřádkové buňky). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

class Rollback extends Error {}
const HEADERS: Record<ImportType, { required: string[]; optional: string[] }> = {
  products: { required: ['sku'], optional: ['name', 'description', 'category', 'unit', 'weight_kg', 'active', 'price_net', 'vat_rate', 'currency', 'price_list', 'stock_qty', 'lead_time_days', 'restock_date', 'attr_*'] },
  calc_rules: { required: ['sku', 'consumption_per_m2'], optional: ['waste_pct', 'pack_size', 'pack_label', 'note'] },
  accessory_rules: { required: ['sku', 'accessory_sku', 'basis', 'factor'], optional: ['waste_pct', 'note'] },
  shipping_zones: { required: ['prefix', 'zone'], optional: [] },
  shipping_rates: { required: ['zone', 'max_weight_kg', 'price_net'], optional: ['label'] },
};
export const importHelp = () => Object.fromEntries(IMPORT_TYPES.map((t) => [t, HEADERS[t]]));

const toNum = (s: string, what: string): number => {
  const v = Number(s.trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(v)) throw new Error(`${what}: „${s}“ není číslo`);
  return v;
};
const toBool = (s: string, what: string): boolean => {
  const v = s.trim().toLowerCase();
  if (['1', 'true', 'ano', 'yes', 'a', 'y'].includes(v)) return true;
  if (['0', 'false', 'ne', 'no', 'n'].includes(v)) return false;
  throw new Error(`${what}: „${s}“ není ano/ne`);
};
const toDate = (s: string, what: string): string => {
  const t = s.trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) return t;
  if ((m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(t))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`${what}: „${s}“ není datum (RRRR-MM-DD nebo D.M.RRRR)`);
};

async function productId(t: Db, sku: string): Promise<string> {
  const r = await t.query<any>('select id from products where sku=$1', [sku.trim()]);
  if (!r.length) throw new Error(`produkt s SKU „${sku}“ neexistuje (nejdřív importujte products)`);
  return r[0].id;
}

export type RowFn = (t: Db, g: (c: string) => string | undefined, has: (c: string) => boolean, cols: string[]) => Promise<'created' | 'updated' | 'unchanged'>;

export const HANDLERS: Record<ImportType, RowFn> = {
  async products(t, g, has, cols) {
    const sku = g('sku')?.trim(); if (!sku) throw new Error('chybí sku');
    const ex = (await t.query<any>('select * from products where sku=$1', [sku]))[0];
    const attrs: Record<string, unknown> = ex?.attributes ? { ...ex.attributes } : {};
    for (const c of cols.filter((c) => c.startsWith('attr_'))) {
      const v = g(c); if (v === undefined || v.trim() === '') continue;
      attrs[c.slice(5)] = Number.isFinite(Number(v.replace(',', '.'))) && v.trim() !== '' ? Number(v.replace(',', '.')) : v.trim();
    }
    const val = {
      name: g('name')?.trim() || ex?.name, description: has('description') ? (g('description') ?? '') : ex?.description ?? '',
      category: g('category')?.trim() || ex?.category || 'ostatni', unit: g('unit')?.trim() || ex?.unit || 'ks',
      weight_kg: g('weight_kg')?.trim() ? toNum(g('weight_kg')!, 'weight_kg') : ex ? Number(ex.weight_kg) : 0,
      active: g('active')?.trim() ? toBool(g('active')!, 'active') : ex?.active ?? true,
    };
    if (!val.name) throw new Error('chybí name u nového produktu');
    if (val.weight_kg < 0) throw new Error('weight_kg nesmí být záporné');
    const search = norm(`${sku} ${val.name} ${val.description} ${val.category}`);
    let id: string; let changed = false;
    if (!ex) {
      id = (await t.query<any>(`insert into products (sku,name,description,category,unit,weight_kg,attributes,active,search_text) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [sku, val.name, val.description, val.category, val.unit, val.weight_kg, JSON.stringify(attrs), val.active, search]))[0].id;
      changed = true;
    } else {
      id = ex.id;
      const same = ex.name === val.name && ex.description === val.description && ex.category === val.category && ex.unit === val.unit && Number(ex.weight_kg) === val.weight_kg
        && ex.active === val.active && JSON.stringify(ex.attributes) === JSON.stringify(attrs);
      if (!same) { await t.query(`update products set name=$2, description=$3, category=$4, unit=$5, weight_kg=$6, attributes=$7, active=$8, search_text=$9, updated_at=now() where id=$1`,
        [id, val.name, val.description, val.category, val.unit, val.weight_kg, JSON.stringify(attrs), val.active, search]); changed = true; }
    }
    if (g('price_net')?.trim()) {
      const amount = toNum(g('price_net')!, 'price_net'); if (amount < 0) throw new Error('price_net nesmí být záporná');
      const vat = g('vat_rate')?.trim() ? toNum(g('vat_rate')!, 'vat_rate') : 21;
      const list = g('price_list')?.trim() || 'retail'; const cur = g('currency')?.trim().toUpperCase() || 'CZK';
      const last = (await t.query<any>(`select id, amount_net, vat_rate, currency, valid_from = current_date as today from prices where product_id=$1 and price_list=$2 and valid_from <= current_date and (valid_to is null or valid_to >= current_date) order by valid_from desc limit 1`, [id, list]))[0];
      if (!last || Number(last.amount_net) !== amount || Number(last.vat_rate) !== vat || last.currency !== cur) {
        if (last?.today) await t.query('update prices set amount_net=$2, vat_rate=$3, currency=$4 where id=$1', [last.id, amount, vat, cur]);
        else {
          if (last) await t.query(`update prices set valid_to=current_date - 1 where id=$1`, [last.id]);
          await t.query('insert into prices (product_id, price_list, amount_net, currency, vat_rate, valid_from) values ($1,$2,$3,$4,$5,current_date)', [id, list, amount, cur, vat]);
        }
        changed = true;
      }
    } else if (!ex) throw new Error('nový produkt musí mít price_net (bez ceny by ho AI nesměla nabízet)');
    if (g('stock_qty')?.trim()) {
      const qty = toNum(g('stock_qty')!, 'stock_qty'); if (qty < 0) throw new Error('stock_qty nesmí být záporné');
      const lead = g('lead_time_days')?.trim() ? Math.round(toNum(g('lead_time_days')!, 'lead_time_days')) : null;
      const restock = g('restock_date')?.trim() ? toDate(g('restock_date')!, 'restock_date') : null;
      const cur = (await t.query<any>('select qty_available, lead_time_days from stock where product_id=$1', [id]))[0];
      if (!cur) { await t.query(`insert into stock (product_id, qty_available, lead_time_days, restock_date, source) values ($1,$2,$3,$4,'import')`, [id, qty, lead ?? 14, restock]); changed = true; }
      else if (Number(cur.qty_available) !== qty || (lead != null && cur.lead_time_days !== lead) || has('restock_date')) {
        await t.query(`update stock set qty_available=$2, lead_time_days=coalesce($3, lead_time_days), restock_date=case when $5 then $4::date else restock_date end, source='import', updated_at=now() where product_id=$1`, [id, qty, lead, restock, has('restock_date')]);
        changed = true;
      }
    }
    return !ex ? 'created' : changed ? 'updated' : 'unchanged';
  },

  async calc_rules(t, g) {
    const id = await productId(t, g('sku') ?? '');
    const cons = toNum(g('consumption_per_m2') ?? '', 'consumption_per_m2'); if (cons <= 0) throw new Error('consumption_per_m2 musí být > 0');
    const waste = g('waste_pct')?.trim() ? toNum(g('waste_pct')!, 'waste_pct') : 5; if (waste < 0 || waste > 100) throw new Error('waste_pct musí být 0–100');
    const pack = g('pack_size')?.trim() ? toNum(g('pack_size')!, 'pack_size') : 1; if (pack <= 0) throw new Error('pack_size musí být > 0');
    const label = g('pack_label')?.trim() || 'ks'; const note = g('note')?.trim() || null;
    const ex = (await t.query<any>('select * from calc_rules where product_id=$1', [id]))[0];
    await t.query(`insert into calc_rules (product_id, consumption_per_m2, waste_pct, pack_size, pack_label, note) values ($1,$2,$3,$4,$5,$6)
      on conflict (product_id) do update set consumption_per_m2=$2, waste_pct=$3, pack_size=$4, pack_label=$5, note=$6`, [id, cons, waste, pack, label, note]);
    if (!ex) return 'created';
    return Number(ex.consumption_per_m2) === cons && Number(ex.waste_pct) === waste && Number(ex.pack_size) === pack && ex.pack_label === label && (ex.note ?? null) === note ? 'unchanged' : 'updated';
  },

  async accessory_rules(t, g) {
    const id = await productId(t, g('sku') ?? ''); const acc = await productId(t, g('accessory_sku') ?? '');
    if (id === acc) throw new Error('příslušenství nemůže být samo sebou');
    const basis = (g('basis') ?? '').trim(); if (!['per_m2', 'per_unit'].includes(basis)) throw new Error('basis musí být per_m2 nebo per_unit');
    const factor = toNum(g('factor') ?? '', 'factor'); if (factor <= 0) throw new Error('factor musí být > 0');
    const waste = g('waste_pct')?.trim() ? toNum(g('waste_pct')!, 'waste_pct') : 0; if (waste < 0 || waste > 100) throw new Error('waste_pct musí být 0–100');
    const note = g('note')?.trim() || null;
    const ex = (await t.query<any>('select * from accessory_rules where product_id=$1 and accessory_product_id=$2', [id, acc]))[0];
    await t.query(`insert into accessory_rules (product_id, accessory_product_id, basis, factor, waste_pct, note) values ($1,$2,$3,$4,$5,$6)
      on conflict (product_id, accessory_product_id) do update set basis=$3, factor=$4, waste_pct=$5, note=$6`, [id, acc, basis, factor, waste, note]);
    if (!ex) return 'created';
    return ex.basis === basis && Number(ex.factor) === factor && Number(ex.waste_pct) === waste && (ex.note ?? null) === note ? 'unchanged' : 'updated';
  },

  async shipping_zones(t, g) {
    const prefix = (g('prefix') ?? '').trim().replace(/\s/g, ''); const zone = (g('zone') ?? '').trim();
    if (!zone) throw new Error('chybí zone'); if (!/^\d*$/.test(prefix)) throw new Error('prefix smí obsahovat jen číslice (prázdný = výchozí zóna)');
    const ex = (await t.query<any>('select zone from shipping_zones where prefix=$1', [prefix]))[0];
    await t.query('insert into shipping_zones (prefix, zone) values ($1,$2) on conflict (prefix) do update set zone=$2', [prefix, zone]);
    return !ex ? 'created' : ex.zone === zone ? 'unchanged' : 'updated';
  },

  async shipping_rates(t, g) { // sazby zóny se nahrazují celé – řeší importCsv (smazání před prvním řádkem zóny)
    const zone = (g('zone') ?? '').trim(); if (!zone) throw new Error('chybí zone');
    const w = toNum(g('max_weight_kg') ?? '', 'max_weight_kg'); const p = toNum(g('price_net') ?? '', 'price_net');
    if (w <= 0 || p < 0) throw new Error('max_weight_kg musí být > 0 a price_net ≥ 0');
    await t.query('insert into shipping_rates (zone, max_weight_kg, price_net, label) values ($1,$2,$3,$4)', [zone, w, p, g('label')?.trim() ?? '']);
    return 'created';
  },
};

/** Import je „všechno nebo nic“: při jakékoli chybě (nebo dry_run) se transakce vrátí a nic se nezapíše. */
export async function importCsv(db: Db, audit: AuditLog, type: ImportType, text: string, opts: { dryRun?: boolean; by: string }): Promise<ImportResult> {
  if (!IMPORT_TYPES.includes(type)) throw new DomainError('validation_error', 'Neznámý typ importu');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new DomainError('validation_error', 'CSV musí mít hlavičku a alespoň jeden řádek');
  if (rows.length > 20_001) throw new DomainError('validation_error', 'Příliš mnoho řádků (max. 20 000)');
  const cols = rows[0].map((c) => c.trim().toLowerCase());
  const miss = HEADERS[type].required.filter((c) => !cols.includes(c));
  if (miss.length) throw new DomainError('validation_error', `Chybí sloupce: ${miss.join(', ')}`);
  const known = new Set([...HEADERS[type].required, ...HEADERS[type].optional.filter((c) => !c.endsWith('*'))]);
  const allowPrefix = HEADERS[type].optional.some((c) => c.endsWith('*'));
  const unknown = cols.filter((c) => c && !known.has(c) && !(allowPrefix && c.startsWith('attr_')));
  if (unknown.length) throw new DomainError('validation_error', `Neznámé sloupce: ${unknown.join(', ')}`);

  const res: ImportResult = { type, dry_run: !!opts.dryRun, applied: false, created: 0, updated: 0, unchanged: 0, errors: [] };
  try {
    await db.tx(async (t) => {
      const clearedZones = new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const line = i + 1;
        const g = (c: string) => { const ix = cols.indexOf(c); return ix < 0 ? undefined : r[ix]; };
        const has = (c: string) => cols.includes(c);
        try {
          if (type === 'shipping_rates') {
            const z = (g('zone') ?? '').trim();
            if (z && !clearedZones.has(z)) { await t.query('delete from shipping_rates where zone=$1', [z]); clearedZones.add(z); }
          }
          await t.query('savepoint row_sp');
          try { res[await HANDLERS[type](t, g, has, cols)]++; await t.query('release savepoint row_sp'); }
          catch (e) { await t.query('rollback to savepoint row_sp'); throw e; }
        } catch (e) { res.errors.push({ line, message: (e as Error).message }); if (res.errors.length >= 50) break; }
      }
      if (res.errors.length || opts.dryRun) throw new Rollback();
      await audit.record(t, { actor_type: opts.by.startsWith('human:') ? 'human' : 'system', actor_id: opts.by, action: 'import.csv', status: 'success',
        entity_type: 'import', entity_id: type, output: { created: res.created, updated: res.updated, unchanged: res.unchanged } });
      res.applied = true;
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return res;
}

/** Vypne ukázková DEMO data (atribut demo=true), aby je AI nenabízela. Nic nemaže. */
export async function deactivateDemo(db: Db, audit: AuditLog, by: string): Promise<number> {
  const r = await db.query<any>(`update products set active=false, updated_at=now() where attributes->>'demo'='true' and active returning id`);
  await audit.record(db, { actor_type: by.startsWith('human:') ? 'human' : 'system', actor_id: by, action: 'import.deactivate_demo', status: 'success', output: { products: r.length } });
  return r.length;
}
