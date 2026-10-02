import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Beleta } from '../src/beleta/bootstrap.js';
import { redact } from '../src/ai-core/index.js';
import { ai, human, makeApp, newCustomer, ok, run } from './helpers.js';

let app: Beleta;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('12. audit log', () => {
  test('úspěšné, zamítnuté i chybné volání je zaznamenáno s aktérem a stavem', async () => {
    await run(app, 'get_price', { product: 'DEMO-TASKA-01' });
    await run(app, 'get_price', {});
    await run(app, 'create_customer', { name: 'No Scope', email: 'x@y.cz' }, { type: 'public', id: 'public:web', scopes: [] });
    await run(app, 'get_product', { product: 'NENI' });
    const rows = await app.core.audit.list(app.db, { limit: 20 });
    const st = rows.map((r: any) => `${r.tool}:${r.status}`);
    expect(st).toEqual(expect.arrayContaining(['get_price:success', 'get_price:validation_error', 'create_customer:forbidden', 'get_product:error']));
    const ok1 = rows.find((r: any) => r.tool === 'get_price' && r.status === 'success');
    expect(ok1).toMatchObject({ actor_type: 'ai', actor_id: ai.id, action: 'tool.call' }); expect(ok1.duration_ms).toBeGreaterThanOrEqual(0);
  });
  test('zápis (create_customer) uloží entity_id a v logu nejsou osobní údaje', async () => {
    const id = await newCustomer(app, 'tajny.email@example.cz');
    const row = (await app.core.audit.list(app.db, { tool: 'create_customer', limit: 1 }))[0];
    expect(row.entity_id).toBe(id);
    const dump = JSON.stringify(await app.db.query('select * from ai_audit_log'));
    for (const pii of ['tajny.email@example.cz', 'Jan Novák', '777 123 456']) expect(dump).not.toContain(pii);
  });
  test('redact maskuje e-maily/telefony ve volném textu i klíčích', () => {
    const r: any = redact({ email: 'a@b.cz', name: 'Petr Svoboda', notes: 'volejte +420 777 888 999 nebo pište na x@y.com', password: 'p', n: 5, nested: { phone: '123456789' } });
    expect(JSON.stringify(r)).not.toMatch(/a@b\.cz|Svoboda|777 888|x@y\.com|123456789/);
    expect(r.n).toBe(5); expect(r.name).toBe('P*** S***');
  });
  test('log je append-only (trigger) a hash řetěz odhalí zásah', async () => {
    await expect(app.db.query(`update ai_audit_log set status='x' where id=(select min(id) from ai_audit_log)`)).rejects.toThrow(/append-only/);
    await expect(app.db.query('delete from ai_audit_log')).rejects.toThrow(/append-only/);
    expect(await app.core.audit.verifyChain(app.db)).toMatchObject({ ok: true });
    await app.db.query('alter table ai_audit_log disable trigger ai_audit_log_no_update');
    const victim = (await app.db.query<any>(`select id from ai_audit_log order by id offset 2 limit 1`))[0].id;
    await app.db.query(`update ai_audit_log set status='success' , output='{"forged":true}' where id=$1`, [victim]);
    await app.db.query('alter table ai_audit_log enable trigger ai_audit_log_no_update');
    const v = await app.core.audit.verifyChain(app.db);
    expect(v.ok).toBe(false); expect(v.brokenAt).toBe(Number(victim));
  });
});

describe('fail-closed', () => {
  test('selže-li zápis auditu, akce se nezapíše', async () => {
    const app2 = await makeApp();
    const customers = async () => (await app2.db.query<any>('select count(*)::int n from customers'))[0].n;
    const before = await customers();
    await app2.db.query(`create or replace function ai_audit_log_immutable() returns trigger language plpgsql as $$ begin raise exception 'ai_audit_log is append-only'; end $$`);
    await app2.db.query(`create trigger ai_audit_fail before insert on ai_audit_log for each row execute function ai_audit_log_immutable()`);
    const r = await run(app2, 'create_customer', { name: 'Fail Closed', email: 'fc@example.cz' }).catch((e) => ({ status: 'thrown', e }));
    expect(r.status).not.toBe('ok');
    expect(await customers()).toBe(before);
    await app2.close();
  });
  test('každý audit záznam schválení odkazuje na approval_id a uchová rozhodnutí', async () => {
    const c = await newCustomer(app, 'aud2@example.cz');
    const r: any = await run(app, 'create_quote', { customer_id: c, items: [{ product: 'DEMO-TASKA-01', qty: 10 }], discount_pct: 7 });
    await app.core.approvals.decide(app.db, r.approval_id, 'reject', human, 'Ne', 'rq');
    const rows = await app.db.query<any>('select action, status, actor_id from ai_audit_log where approval_id=$1 order by id', [r.approval_id]);
    expect(rows.map((x) => `${x.action}:${x.status}`)).toEqual(['approval.created:pending_approval', 'approval.decided:rejected']);
    expect(rows[1].actor_id).toBe(human.id);
    void ok;
  });
});

describe('hash řetěz – regrese', () => {
  test('záznamy s undefined/Date/vnořenými hodnotami se ověří', async () => {
    const fresh = await makeApp(); // sdílená DB je po testu s ručním zásahem záměrně porušená
    await fresh.core.audit.record(fresh.db, { actor_type: 'system', actor_id: 'system:t', action: 'x', status: 'success', input: { a: undefined, b: new Date('2026-01-01'), c: [1, { d: undefined }] }, output: undefined });
    expect(await fresh.core.audit.verifyChain(fresh.db)).toMatchObject({ ok: true });
    await fresh.close();
  });
});
