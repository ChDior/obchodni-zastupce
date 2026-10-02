import { randomUUID } from 'node:crypto';
import { AuditLog } from './audit.js';
import { redact } from './redact.js';
import type { ApprovalService } from './approvals.js';
import type { ToolRegistry } from './registry.js';
import { DomainError, type Db, type PolicyReader, type ToolContext, type ToolResult, type Source } from './types.js';

export type BaseContext = Omit<ToolContext, 'db' | 'policy'> & { db: Db; policy: PolicyReader };

export interface ApprovedExecution { approvalId: string; approvedBy: string }

/**
 * JEDINÝ vstup pro jakoukoli akci AI nad daty:
 * validace -> autorizace (scope) -> guard (deterministická pravidla) -> handler v transakci + audit (fail-closed).
 */
export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private audit: AuditLog,
    private approvals: ApprovalService,
    private makePolicy: (db: Db) => PolicyReader,
    private log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  async execute(name: string, rawInput: unknown, base: BaseContext, approved?: ApprovedExecution): Promise<ToolResult> {
    const started = Date.now();
    const baseAudit = {
      request_id: base.requestId, actor_type: base.actor.type, actor_id: base.actor.id, tool: name,
      conversation_id: base.conversationId, action: approved ? 'tool.call.approved' : 'tool.call',
      approval_id: approved?.approvalId,
    };
    const fail = async (status: string, code: string, message: string, details?: unknown): Promise<ToolResult> => {
      await this.audit.record(base.db, { ...baseAudit, status, error_code: code, input: redact(rawInput),
        output: { message }, duration_ms: Date.now() - started });
      return { status: 'error', error: { code, message, details } };
    };

    const tool = this.registry.get(name);
    if (!tool) return fail('error', 'unknown_tool', `Neznámý nástroj: ${name}`);

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      return fail('validation_error', 'validation_error', 'Neplatný vstup nástroje',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const input = parsed.data;

    const { scopes } = base.actor;
    if (!scopes.includes('*') && !scopes.includes(tool.scope)) {
      return fail('forbidden', 'forbidden', `Aktér ${base.actor.id} nemá oprávnění ${tool.scope}`);
    }

    const ctxFor = (db: Db): ToolContext => ({ ...base, db, policy: this.makePolicy(db) });

    if (tool.guard) {
      let g;
      try { g = await tool.guard(ctxFor(base.db), input); }
      catch (err) {
        if (err instanceof DomainError) return fail('error', err.code, err.message, err.details);
        this.log(`guard ${name} internal error`, err);
        return fail('error', 'internal_error', 'Interní chyba při kontrole pravidel');
      }
      if (g.decision === 'deny') return fail('denied', g.code, g.message);
      if (g.decision === 'approval' && !approved) {
        const a = await this.approvals.create(base.db, {
          tool: name, category: g.category, summary: g.summary, reason: g.reason, input: rawInput,
          actor: base.actor, conversationId: base.conversationId,
        });
        await this.audit.record(base.db, { ...baseAudit, action: 'approval.created', status: 'pending_approval',
          input: redact(rawInput), output: { category: g.category, summary: g.summary }, approval_id: a.id,
          duration_ms: Date.now() - started });
        return { status: 'pending_approval', approval_id: a.id, category: g.category,
          message: `Akce vyžaduje schválení člověkem (${g.category}). Nic nebylo provedeno.` };
      }
    }

    try {
      return await base.db.tx(async (tx) => {
        const res = await tool.handler(ctxFor(tx), input);
        const sources: Source[] = res.sources ?? [];
        await this.audit.record(tx, { ...baseAudit, status: 'success', entity_type: res.entity?.type, entity_id: res.entity?.id,
          input: redact(rawInput), output: redact(res.data), duration_ms: Date.now() - started });
        return { status: 'ok', data: res.data, sources } as ToolResult;
      });
    } catch (err) {
      if (err instanceof DomainError) return fail('error', err.code, err.message, err.details);
      this.log(`tool ${name} internal error`, err);
      return fail('error', 'internal_error', 'Interní chyba nástroje');
    }
  }

  /** Spustí akci po lidském schválení (vstup se znovu validuje, deny-pravidla stále platí). */
  async executeApproved(toolName: string, input: unknown, base: BaseContext, approval: ApprovedExecution) {
    return this.execute(toolName, input, base, approval);
  }

  static newRequestId() { return randomUUID(); }
}
