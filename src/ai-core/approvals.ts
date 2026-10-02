import { AuditLog } from './audit.js';
import { redact } from './redact.js';
import type { ToolExecutor, BaseContext } from './executor.js';
import { DomainError, type Actor, type Db } from './types.js';
import type { PolicyStore } from './policy.js';

export interface CreateApproval {
  tool?: string; category: string; summary: string; reason?: string; input?: unknown;
  actor: Actor; conversationId?: string;
}

export class ApprovalService {
  private executor!: ToolExecutor;
  constructor(
    private audit: AuditLog,
    private policy: PolicyStore,
    private baseDeps: () => { deps: Record<string, any>; now: () => Date },
  ) {}
  setExecutor(e: ToolExecutor) { this.executor = e; }

  async create(db: Db, a: CreateApproval) {
    // policy čteme přes stejné spojení (db může být transakce; jediné spojení by jinak způsobilo deadlock)
    const hours = Number(await this.policy.withDb(db).get('approval.expires_hours', 72));
    const rows = await db.query<{ id: string }>(
      `insert into ai_approvals (tool, category, summary, reason, input, actor_type, actor_id, conversation_id, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval) returning id`,
      [a.tool ?? null, a.category, a.summary, a.reason ?? null, a.input === undefined ? null : JSON.stringify(a.input),
       a.actor.type, a.actor.id, a.conversationId ?? null, String(hours)]);
    return { id: rows[0].id };
  }

  async list(db: Db, status?: string, limit = 100) {
    return db.query(
      `select id, created_at, tool, category, summary, reason, input, actor_type, actor_id, status, decided_by, decided_at,
              decision_note, result, error, expires_at
       from ai_approvals ${status ? 'where status = $2' : ''} order by created_at desc limit $1`,
      status ? [limit, status] : [limit]);
  }

  async get(db: Db, id: string) {
    const r = await db.query('select * from ai_approvals where id=$1', [id]);
    return r[0] ?? null;
  }

  /** Rozhodnutí člověka. Atomicky pending -> approved|rejected; při schválení provede akci. */
  async decide(db: Db, id: string, decision: 'approve' | 'reject', human: Actor, note: string | undefined, requestId: string) {
    if (human.type !== 'human') throw new DomainError('forbidden', 'Schvalovat smí jen člověk');
    await db.query(`update ai_approvals set status='expired' where status='pending' and expires_at < now()`);
    const upd = await db.query<any>(
      `update ai_approvals set status=$2, decided_by=$3, decided_at=now(), decision_note=$4
       where id=$1 and status='pending' returning *`,
      [id, decision === 'approve' ? 'approved' : 'rejected', human.id, note ?? null]);
    if (!upd.length) {
      const cur = await this.get(db, id);
      if (!cur) throw new DomainError('not_found', 'Žádost o schválení neexistuje');
      throw new DomainError('not_pending', `Žádost už je ve stavu ${cur.status}`);
    }
    const ap = upd[0];
    await this.audit.record(db, { request_id: requestId, actor_type: human.type, actor_id: human.id,
      action: 'approval.decided', tool: ap.tool ?? undefined, status: decision === 'approve' ? 'approved' : 'rejected',
      approval_id: ap.id, input: { category: ap.category }, output: redact({ note }) });

    if (decision === 'reject' || !ap.tool) return this.get(db, id);

    // provedení schválené akce jako původní AI aktér; scope už byl ověřen při vzniku žádosti
    const aiActor: Actor = { type: ap.actor_type, id: ap.actor_id, scopes: ['*'] };
    const { deps, now } = this.baseDeps();
    const base: BaseContext = { db, actor: aiActor, requestId, conversationId: ap.conversation_id ?? undefined,
      policy: this.policy, deps, now };
    const res = await this.executor.executeApproved(ap.tool, ap.input, base, { approvalId: ap.id, approvedBy: human.id });
    if (res.status === 'ok') {
      await db.query(`update ai_approvals set status='executed', result=$2 where id=$1`, [id, JSON.stringify(redact(res.data))]);
    } else {
      const msg = res.status === 'error' ? `${res.error.code}: ${res.error.message}` : 'unexpected pending_approval';
      await db.query(`update ai_approvals set status='failed', error=$2 where id=$1`, [id, msg]);
    }
    return this.get(db, id);
  }
}
