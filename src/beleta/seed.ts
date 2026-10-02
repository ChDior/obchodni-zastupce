import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../ai-core/index.js';
import { upsertDocument } from './knowledge.js';
import { norm } from './util.js';

/** UKÁZKOVÁ data pro vývoj/testy (atribut demo=true). Produkční ceny/sklad se importují z ERP/CSV, ne odtud. */
export async function seedDemo(db: Db, opts: { knowledgeDir?: string } = {}) {
  const exists = await db.query<any>('select 1 from products limit 1');
  if (!exists.length) {
    const P: Array<[string, string, string, string, string, number, any, number, number, number, number]> = [
      // sku, name, description, category, unit, weight, attrs, price, stockQty, leadDays, vat
      ['DEMO-TASKA-01', 'Betonová střešní taška Klasik (DEMO)', 'Základní betonová taška pro sedlové střechy.', 'krytina', 'ks', 4.3, { demo: true, min_sklon_stupne: 22 }, 38, 12000, 14, 21],
      ['DEMO-TASKA-02', 'Betonová střešní taška Premium (DEMO)', 'Prémiová betonová taška, zvýšená mrazuvzdornost.', 'krytina', 'ks', 4.6, { demo: true, min_sklon_stupne: 15 }, 52, 0, 28, 21],
      ['DEMO-LATE-01', 'Střešní lať 40x60 (DEMO)', 'Smrková impregnovaná lať.', 'prislusenstvi', 'm', 1.2, { demo: true }, 28, 5000, 7, 21],
      ['DEMO-FOLIE-01', 'Difuzní fólie (DEMO)', 'Pojistná hydroizolace, role.', 'prislusenstvi', 'm2', 0.15, { demo: true }, 32, 3000, 7, 21],
      ['DEMO-SPONA-01', 'Spona na tašku (DEMO)', 'Nerezová spona pro zajištění tašek.', 'prislusenstvi', 'ks', 0.03, { demo: true }, 4.5, 50000, 7, 21],
    ];
    const ids: Record<string, string> = {};
    for (const [sku, name, desc, cat, unit, w, attrs, price, qty, lead, vat] of P) {
      const r = await db.query<any>(
        `insert into products (sku,name,description,category,unit,weight_kg,attributes,search_text) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [sku, name, desc, cat, unit, w, JSON.stringify(attrs), norm(`${sku} ${name} ${desc} ${cat}`)]);
      ids[sku] = r[0].id;
      await db.query('insert into prices (product_id, amount_net, vat_rate) values ($1,$2,$3)', [ids[sku], price, vat]);
      await db.query('insert into stock (product_id, qty_available, lead_time_days, source) values ($1,$2,$3,$4)', [ids[sku], qty, lead, 'demo']);
    }
    await db.query(`insert into calc_rules (product_id, consumption_per_m2, waste_pct, pack_size, pack_label, note) values
      ($1, 10, 5, 300, 'paleta', 'Spotřeba 10 ks/m², ztráty 5 %, prodej po paletách (DEMO)'),
      ($2, 10, 5, 240, 'paleta', 'Spotřeba 10 ks/m², ztráty 5 %, prodej po paletách (DEMO)')`, [ids['DEMO-TASKA-01'], ids['DEMO-TASKA-02']]);
    for (const main of ['DEMO-TASKA-01', 'DEMO-TASKA-02']) {
      await db.query(`insert into accessory_rules (product_id, accessory_product_id, basis, factor, waste_pct, note) values
        ($1,$2,'per_m2',3.2,5,'Střešní latě, bm na m²'), ($1,$3,'per_m2',1.15,0,'Difuzní fólie s přesahy'), ($1,$4,'per_unit',1,2,'Jedna spona na tašku')`,
        [ids[main], ids['DEMO-LATE-01'], ids['DEMO-FOLIE-01'], ids['DEMO-SPONA-01']]);
    }
    await db.query(`insert into shipping_zones (prefix, zone) values ('', 'B'), ('1', 'A')`);
    await db.query(`insert into shipping_rates (zone, max_weight_kg, price_net, label) values
      ('A', 3500, 2400, 'Valník do 3,5 t'), ('A', 12000, 4500, 'Nákladní vůz s HR'),
      ('B', 3500, 3200, 'Valník do 3,5 t'), ('B', 12000, 5900, 'Nákladní vůz s HR')`);
  }
  const dir = opts.knowledgeDir;
  if (dir) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const content = readFileSync(join(dir, f), 'utf8');
      const title = content.split('\n')[0].replace(/^#\s*/, '').trim() || f;
      await upsertDocument(db, { title, content, category: 'technical', source: `file:${f}` });
    }
  }
}
