import { bootstrap, type Beleta } from '../src/beleta/bootstrap.js';
import { humanActor, webAdvisorActor, publicActor } from '../src/beleta/actors.js';
import type { Actor, LlmProvider, ToolResult } from '../src/ai-core/index.js';
import { randomUUID } from 'node:crypto';

export async function makeApp(opts: { llm?: LlmProvider; now?: () => Date } = {}): Promise<Beleta> {
  return bootstrap({ seedDemo: true, now: opts.now ?? (() => new Date('2026-10-02T10:00:00Z')), llm: opts.llm,
    admin: { email: 'admin@test.cz', password: 'test-password-123' } });
}

export const ai = webAdvisorActor();
export const human = humanActor({ id: 'u1', email: 'obchodnik@test.cz' });
export const pub = publicActor();

export function run(app: Beleta, tool: string, input: unknown, actor: Actor = ai): Promise<ToolResult> {
  return app.core.executor.execute(tool, input, { db: app.db, actor, requestId: randomUUID(), policy: app.core.policy, deps: app.core.deps, now: app.core.now });
}

export function ok<T = any>(r: ToolResult): T {
  if (r.status !== 'ok') throw new Error('expected ok, got ' + JSON.stringify(r));
  return r.data as T;
}

export async function sku(app: Beleta, s: string): Promise<string> {
  return (await app.db.query<any>('select id from products where sku=$1', [s]))[0].id;
}

export async function newCustomer(app: Beleta, email = 'jan.novak@example.cz') {
  return ok<{ customer_id: string }>(await run(app, 'create_customer', { name: 'Jan Novák', email, phone: '+420 777 123 456' })).customer_id;
}
