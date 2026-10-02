import { AuditLog } from './audit.js';
import { ApprovalService } from './approvals.js';
import { ToolExecutor } from './executor.js';
import { PolicyStore } from './policy.js';
import { ToolRegistry } from './registry.js';
import type { Db } from './types.js';

export * from './types.js';
export * from './db.js';
export * from './audit.js';
export * from './approvals.js';
export * from './executor.js';
export * from './policy.js';
export * from './registry.js';
export * from './redact.js';
export * from './llm.js';
export { runAgent, type AgentDef, type RunResult, type TraceItem } from './agent.js';

export interface AiCore {
  registry: ToolRegistry;
  audit: AuditLog;
  approvals: ApprovalService;
  executor: ToolExecutor;
  policy: PolicyStore;
  deps: Record<string, any>;
  now: () => Date;
}

/** Sestaví doménově nezávislé jádro. Doména (BELETA / CIHLICKY) dodá tools, agenty a deps. */
export function createAiCore(opts: { db: Db; deps?: Record<string, any>; now?: () => Date; log?: (m: string, e?: unknown) => void }): AiCore {
  const now = opts.now ?? (() => new Date());
  const deps = opts.deps ?? {};
  const policy = new PolicyStore(opts.db);
  const audit = new AuditLog(now);
  const registry = new ToolRegistry();
  const approvals = new ApprovalService(audit, policy, () => ({ deps, now }));
  const executor = new ToolExecutor(registry, audit, approvals, (db) => policy.withDb(db), opts.log);
  approvals.setExecutor(executor);
  return { registry, audit, approvals, executor, policy, deps, now };
}
