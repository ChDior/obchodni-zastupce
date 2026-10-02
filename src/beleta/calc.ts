import { DomainError, type Db } from '../ai-core/index.js';
import { getPrice, resolveProduct } from './catalog.js';
import { num, round2, round3 } from './util.js';

async function priceOrNull(db: Db, productId: string) {
  try { return await getPrice(db, productId); } catch (e) { if (e instanceof DomainError) return null; throw e; }
}

export async function calculateMaterial(db: Db, ref: string, areaM2: number) {
  const p = await resolveProduct(db, ref);
  const rr = await db.query<any>('select * from calc_rules where product_id=$1', [p.id]);
  if (!rr.length) throw new DomainError('no_calc_rule', `Pro produkt ${p.sku} nejsou kalkulační pravidla – předejte člověku`);
  const r = rr[0];
  const consumption = num(r.consumption_per_m2); const waste = num(r.waste_pct); const packSize = num(r.pack_size);
  const required = round3((areaM2 * consumption * (100 + waste)) / 100);
  const packs = Math.ceil(round3(required / packSize));
  const qty = round3(packs * packSize);
  const price = await priceOrNull(db, p.id);
  return {
    product: { id: p.id, sku: p.sku, name: p.name, unit: p.unit },
    area_m2: areaM2, consumption_per_m2: consumption, waste_pct: waste,
    required_qty: required, pack_size: packSize, pack_label: r.pack_label as string, packs, order_qty: qty,
    total_weight_kg: round2(qty * num(p.weight_kg)),
    unit_price_net: price?.amount_net ?? null, currency: price?.currency ?? null,
    line_net: price ? round2(qty * price.amount_net) : null,
    price_available: !!price,
    note: r.note ?? null,
  };
}

export async function calculateAccessories(db: Db, ref: string, input: { area_m2?: number; quantity?: number }) {
  const p = await resolveProduct(db, ref);
  const rules = await db.query<any>(
    `select a.*, ap.id as acc_id, ap.sku, ap.name, ap.unit, ap.weight_kg from accessory_rules a
     join products ap on ap.id = a.accessory_product_id where a.product_id=$1 and ap.active order by ap.name`, [p.id]);
  const items = [];
  for (const r of rules) {
    let base: number | undefined;
    if (r.basis === 'per_m2') base = input.area_m2; else base = input.quantity;
    if (base == null) {
      throw new DomainError('missing_input', r.basis === 'per_m2'
        ? 'Pro příslušenství je třeba area_m2' : 'Pro příslušenství je třeba quantity hlavního produktu');
    }
    const qty = Math.ceil(round3((base * num(r.factor) * (100 + num(r.waste_pct))) / 100));
    const price = await priceOrNull(db, r.acc_id);
    items.push({ product: { id: r.acc_id as string, sku: r.sku as string, name: r.name as string, unit: r.unit as string },
      basis: r.basis as string, factor: num(r.factor), order_qty: qty, note: r.note ?? null,
      unit_price_net: price?.amount_net ?? null, line_net: price ? round2(qty * price.amount_net) : null,
      weight_kg: round2(qty * num(r.weight_kg)), price_available: !!price });
  }
  return { main_product: { id: p.id, sku: p.sku, name: p.name }, items };
}

export async function calculateShipping(db: Db, items: Array<{ product: string; qty: number }>, postalCode: string) {
  let weight = 0;
  for (const it of items) { const p = await resolveProduct(db, it.product); weight += num(p.weight_kg) * it.qty; }
  weight = round2(weight);
  const zones = await db.query<any>('select prefix, zone from shipping_zones');
  const pc = postalCode.replace(/\s/g, '');
  const match = zones.filter((z) => pc.startsWith(z.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) throw new DomainError('shipping_unavailable', 'Pro dané PSČ není doprava definována – předejte člověku');
  const rates = await db.query<any>('select * from shipping_rates where zone=$1 order by max_weight_kg', [match.zone]);
  if (!rates.length) throw new DomainError('shipping_unavailable', 'Pro zónu nejsou ceníky dopravy');
  const fit = rates.find((r) => num(r.max_weight_kg) >= weight);
  let price: number; let vehicles = 1; let label: string;
  if (fit) { price = num(fit.price_net); label = fit.label; }
  else { const big = rates[rates.length - 1]; vehicles = Math.ceil(weight / num(big.max_weight_kg)); price = round2(vehicles * num(big.price_net)); label = big.label; }
  return { postal_code: pc, zone: match.zone as string, total_weight_kg: weight, vehicles, vehicle_label: label as string,
    price_net: price, estimated: true,
    disclaimer: 'Orientační cena dopravy; termín doručení nelze potvrdit bez schválení obchodníkem.' };
}
