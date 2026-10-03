import { createHash } from 'node:crypto';
import type { Db } from './types.js';

export interface AuditEntry {
  request_id?: string;
  actor_type: string;
  actor_id: string;
  action: string;           // tool.call | approval.created | approval.decided | auth.login | ...
  tool?: string;
  status: string;           // success | error | denied | validation_error | forbidden | pending_approval | ...
  entity_type?: string;
  entity_id?: string;
  input?: unknown;          // MUSÍ být už zredigováno
  output?: unknown;         // MUSÍ být už zredigováno
  error_code?: string;
  approval_id?: string;
  conversation_id?: string;
  duration_ms?: number;
}

export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

function hashRow(prev: string, ts: string, e: AuditEntry): string {
  return createHash('sha256').update(canonical([
    prev, ts, e.request_id ?? null, e.actor_type, e.actor_id, e.action, e.tool ?? null, e.status,
    e.entity_type ?? null, e.entity_id ?? null, e.input ?? null, e.output ?? null,
    e.error_code ?? null, e.approval_id ?? null, e.conversation_id ?? null,
  ])).digest('hex');
}

export class AuditLog {
  constructor(private now: () => Date = () => new Date()) {}

  /** Zapíše záznam s hash řetězem (detekce zásahů). Volat uvnitř transakce akce => fail-closed. */
  async record(db: Db, entry: AuditEntry): Promise<void> {
    // JSON round-trip: hash musí vycházet z přesně té podoby, která se uloží (undefined klíče, Date apod.)
    const norm = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const e: AuditEntry = { ...entry, input: norm(entry.input), output: norm(entry.output) };
    const run = async (t: Db) => {
      // serializace zápisů řetězu (na skutečném PostgreSQL by dvě souběžné transakce vzaly stejný poslední hash a řetěz by se rozvětvil)
      await t.query('select pg_advisory_xact_lock(7340001)');
      const last = await t.query<{ hash: string }>('select hash from ai_audit_log order by id desc limit 1');
      const prev = last[0]?.hash ?? 'GENESIS';
      const ts = this.now().toISOString();
      const hash = hashRow(prev, ts, e);
      await t.query(
        `insert into ai_audit_log (ts, request_id, actor_type, actor_id, action, tool, status, entity_type, entity_id,
           input, output, error_code, approval_id, conversation_id, duration_ms, prev_hash, hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [ts, e.request_id ?? null, e.actor_type, e.actor_id, e.action, e.tool ?? null, e.status,
         e.entity_type ?? null, e.entity_id ?? null,
         e.input === undefined ? null : JSON.stringify(e.input), e.output === undefined ? null : JSON.stringify(e.output),
         e.error_code ?? null, e.approval_id ?? null, e.conversation_id ?? null, e.duration_ms ?? null, prev, hash],
      );
    };
    await db.tx(run);
  }

  async list(db: Db, f: { tool?: string; status?: string; actor?: string; limit?: number; offset?: number } = {}) {
    const w: string[] = []; const p: unknown[] = [];
    if (f.tool) { p.push(f.tool); w.push(`tool = $${p.length}`); }
    if (f.status) { p.push(f.status); w.push(`status = $${p.length}`); }
    if (f.actor) { p.push(f.actor); w.push(`actor_id = $${p.length}`); }
    p.push(Math.min(f.limit ?? 100, 500)); p.push(f.offset ?? 0);
    return db.query(
      `select id, ts, request_id, actor_type, actor_id, action, tool, status, entity_type, entity_id, input, output,
              error_code, approval_id, conversation_id, duration_ms
       from ai_audit_log ${w.length ? 'where ' + w.join(' and ') : ''}
       order by id desc limit $${p.length - 1} offset $${p.length}`, p);
  }

  /** Ověří celý hash řetěz. Vrací id prvního porušeného záznamu nebo null. */
  async verifyChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
    const rows = await db.query<any>('select * from ai_audit_log order by id asc');
    let prev = 'GENESIS';
    for (const r of rows) {
      const entry: AuditEntry = {
        request_id: r.request_id ?? undefined, actor_type: r.actor_type, actor_id: r.actor_id, action: r.action,
        tool: r.tool ?? undefined, status: r.status, entity_type: r.entity_type ?? undefined, entity_id: r.entity_id ?? undefined,
        input: r.input ?? undefined, output: r.output ?? undefined, error_code: r.error_code ?? undefined,
        approval_id: r.approval_id ?? undefined, conversation_id: r.conversation_id ?? undefined,
      };
      const ts = new Date(r.ts).toISOString();
      if (r.prev_hash !== prev || hashRow(prev, ts, entry) !== r.hash) return { ok: false, checked: rows.length, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
  }
}
