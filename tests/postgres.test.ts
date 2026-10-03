import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { openPg } from '../src/ai-core/index.js';
import { bootstrap } from '../src/beleta/bootstrap.js';
import { createQuote } from '../src/beleta/crm.js';
import { ai, human, newCustomer, ok, run } from './helpers.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const schema = () => 't_' + randomUUID().replace(/-/g, '');

// Běží jen s TEST_DATABASE_URL (skutečný PostgreSQL server); jinak se přeskočí.
describe.skipIf(!DB_URL)('PostgreSQL adaptér', () => {
  test('transakce: commit, rollback, vnořená tx se spojí; typy int8 a date', async () => {
    const db = await openPg(DB_URL!, { schema: schema(), dropSchemaOnClose: true });
    await db.query('create table t (id bigserial primary key, v text, d date)');
    await db.tx(async (t) => { await t.query(`insert into t (v, d) values ('a', '2026-03-01')`); await t.tx(async (n) => { await n.query(`insert into t (v) values ('b')`); }); });
    await expect(db.tx(async (t) => { await t.query(`insert into t (v) values ('c')`); throw new Error('boom'); })).rejects.toThrow('boom');
    const rows = await db.query<any>('select * from t order by id');
    expect(rows.map((r) => r.v)).toEqual(['a', 'b']);
    expect(typeof rows[0].id).toBe('number');
    expect(rows[0].d).toBe('2026-03-01');
    expect((await db.query<any>('select count(*) as n from t'))[0].n).toBe(2);
    await db.close();
  });

  test('bootstrap přes databaseUrl, migrace jsou idempotentní, soubežné zápisy auditu drží hash řetěz a čísla nabídek jsou unikátní', async () => {
    const sch = schema();
    const u = new URL(DB_URL!);
    // schéma řešíme přes opci search_path v URL, aby si ho bootstrap(databaseUrl) otevřel sám
    const setup = await openPg(DB_URL!, { schema: sch });
    await setup.close();
    const urlWithSchema = `${u.toString()}${u.search ? '&' : '?'}options=${encodeURIComponent('-c search_path=' + sch)}`;
    const app = await bootstrap({ databaseUrl: urlWithSchema, now: () => new Date('2026-10-02T10:00:00Z'), admin: { email: 'admin@test.cz', password: 'test-password-123' } });
    try {
      const again = await bootstrap({ databaseUrl: urlWithSchema, seedDemo: false });
      await again.close();
      const c = await newCustomer(app);
      await Promise.all(Array.from({ length: 12 }, () => run(app, 'search_products', { query: 'taška' })));
      expect((await app.core.audit.verifyChain(app.db)).ok).toBe(true);
      const nums = await Promise.all(Array.from({ length: 8 }, () => createQuote(app.db, app.core.policy, { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 1 }] } as any, ai, new Date('2026-10-02T10:00:00Z')).then((q) => q.number)));
      expect(new Set(nums).size).toBe(8);
      // dvě souběžná rozhodnutí o téže žádosti: právě jedno uspěje
      const ap: any = await app.core.approvals.create(app.db, { category: 'other', summary: 'test', actor: ai });
      const id = ap.id ?? ap.approval_id ?? ap;
      const res = await Promise.allSettled([1, 2].map(() => app.core.approvals.decide(app.db, id, 'approve', human, undefined, randomUUID())));
      expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
      expect(ok((await run(app, 'get_price', { product: 'DEMO-TASKA-01' })) as any)).toMatchObject({ amount_net: 38 });
    } finally {
      await app.db.query(`drop schema ${sch} cascade`).catch(() => {});
      await app.close();
    }
  });
});
