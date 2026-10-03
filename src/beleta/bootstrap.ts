import { join } from 'node:path';
import { ROOT } from './paths.js';
import { createAiCore, migrate, openPglite, runAgent, DomainError, redact,
  type AiCore, type Db, type LlmProvider, type LlmMessage, type Source } from '../ai-core/index.js';
import { followupBotActor, webAdvisorActor } from './actors.js';
import { loadAgents } from './agents.js';
import { ensureAdmin } from './auth.js';
import { emailTransportFromEnv, type EmailTransport } from './email.js';
import { LocalKnowledge, type KnowledgeProvider } from './knowledge.js';
import { seedDemo } from './seed.js';
import { buildTools } from './tools.js';
import { randomUUID } from 'node:crypto';

export { ROOT };

export interface BootstrapOptions {
  db?: Db; dataDir?: string; llm?: LlmProvider; emailTransport?: EmailTransport; knowledge?: KnowledgeProvider;
  now?: () => Date; seedDemo?: boolean; admin?: { email: string; password: string }; log?: (m: string, e?: unknown) => void;
}

export async function bootstrap(opts: BootstrapOptions = {}) {
  const db = opts.db ?? await openPglite(opts.dataDir);
  await migrate(db, [join(ROOT, 'db/core'), join(ROOT, 'db/beleta')]);
  if (opts.seedDemo !== false) await seedDemo(db, { knowledgeDir: join(ROOT, 'data/knowledge') });
  if (opts.admin) await ensureAdmin(db, opts.admin.email, opts.admin.password);

  const emailTransport = opts.emailTransport ?? emailTransportFromEnv();
  const core = createAiCore({ db, now: opts.now, log: opts.log, deps: { emailTransport } });
  core.deps.approvals = core.approvals;
  core.registry.register(...buildTools({ knowledge: opts.knowledge ?? new LocalKnowledge() }));
  const agents = loadAgents(join(ROOT, 'agents'));
  const llm = opts.llm;
  const log = opts.log ?? (() => {});

  const baseFor = (actor: ReturnType<typeof webAdvisorActor>, conversationId?: string) => ({
    db, actor, requestId: randomUUID(), conversationId, policy: core.policy, deps: core.deps, now: core.now });

  /** Webový AI poradce. Jediná cesta, jak zákazník mluví s AI. */
  async function chat(input: { conversationId?: string; message: string }) {
    if (!llm) throw new DomainError('ai_unavailable', 'AI poradce momentálně není k dispozici');
    const message = input.message.trim();
    if (!message || message.length > 2000) throw new DomainError('bad_message', 'Zpráva musí mít 1–2000 znaků');

    let convId = input.conversationId;
    if (convId) {
      const ex = /^[0-9a-f-]{36}$/i.test(convId) ? await db.query('select id from ai_conversations where id=$1', [convId]) : [];
      if (!ex.length) convId = undefined;
    }
    if (!convId) convId = (await db.query<any>(`insert into ai_conversations (channel) values ('web') returning id`))[0].id;
    const prior = await db.query<any>(`select role, content from (select id, role, content from ai_messages where conversation_id=$1 order by id desc limit 20) t order by id`, [convId]);
    const history: LlmMessage[] = [...prior.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })), { role: 'user', content: message }];
    await db.query(`insert into ai_messages (conversation_id, role, content) values ($1,'user',$2)`, [convId, message]);

    let reply: string; let sources: Source[] = []; let approvalIds: string[] = [];
    try {
      const res = await runAgent(agents.salesManager, history, { core, llm, base: baseFor(webAdvisorActor(), convId) });
      reply = res.reply || 'Omlouvám se, nedokázal jsem odpovědět. Zkuste to prosím jinak.';
      sources = res.sources; approvalIds = res.approvalIds;
    } catch (err) {
      log('chat error', err);
      await core.audit.record(db, { actor_type: 'ai', actor_id: 'ai:web-advisor', action: 'agent.run', tool: 'SALES_MANAGER', status: 'error',
        error_code: 'llm_failure', conversation_id: convId, output: redact({ message: String((err as Error).message).slice(0, 200) }) });
      reply = 'Omlouvám se, došlo k technické chybě. Zkuste to prosím za chvíli nebo nás kontaktujte přímo.';
    }
    await db.query(`insert into ai_messages (conversation_id, role, content) values ($1,'assistant',$2)`, [convId, reply]);
    await db.query(`update ai_conversations set last_active=now() where id=$1`, [convId]);
    return { conversation_id: convId as string, reply, sources, awaiting_approval: approvalIds.length > 0 };
  }

  /** Spouští se z n8n cronu. Pro splatné follow-upy připraví e-mail (přes schvalování) nebo úkol pro člověka. */
  async function runDueFollowups(limit = 20) {
    const due = await db.query<any>(
      `select f.*, c.name as customer_name from followups f join customers c on c.id=f.customer_id
       where f.status='pending' and f.due_at <= now() order by f.due_at limit $1`, [limit]);
    let processed = 0;
    for (const f of due) {
      const claimed = await db.query(`update followups set status='draft_created' where id=$1 and status='pending' returning id`, [f.id]);
      if (!claimed.length) continue;
      const base = baseFor(followupBotActor());
      if (f.channel === 'email' && llm) {
        const task = `Připrav follow-up e-mail zákazníkovi (customer_id=${f.customer_id}${f.quote_id ? `, quote_id=${f.quote_id}` : ''}, followup_id=${f.id}). ` +
          `Účel: ${f.purpose}. Poznámka: ${f.note || '-'}. Použij send_email.`;
        try { await runAgent(agents.communication, [{ role: 'user', content: task }], { core, llm, base }); }
        catch (err) { log('followup agent error', err); await core.approvals.create(db, { category: 'other', summary: `Follow-up ${f.id} selhal u AI – řešte ručně`, actor: base.actor }); }
      } else {
        await core.approvals.create(db, { category: 'other', summary: `Splatný follow-up (${f.channel}) pro zákazníka ${f.customer_name}: ${f.purpose}`,
          reason: 'Follow-up vyžaduje lidskou akci (telefon/úkol)', input: { followup_id: f.id, customer_id: f.customer_id }, actor: base.actor });
      }
      await core.audit.record(db, { actor_type: 'ai', actor_id: base.actor.id, action: 'followup.processed', status: 'success', entity_type: 'followup', entity_id: f.id,
        output: { channel: f.channel } });
      processed++;
    }
    return { processed };
  }

  return { db, core, agents, llm, chat, runDueFollowups, emailTransport, close: () => db.close() };
}
export type Beleta = Awaited<ReturnType<typeof bootstrap>>;
export type { AiCore };
