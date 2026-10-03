import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.js';
import { recordLlmUsage } from './usage.js';
import type { AiCore } from './index.js';
import type { BaseContext } from './executor.js';
import type { LlmMessage, LlmProvider, LlmToolSpec } from './llm.js';
import type { Source } from './types.js';

export interface AgentDef {
  name: string;
  instructions: string;
  /** Whitelist nástrojů; vše ostatní agent nesmí volat. */
  tools: string[];
  /** Specialisté, na které smí agent delegovat (handoff jako nástroj delegate_<klíč>). */
  delegates?: Record<string, { agent: AgentDef; description: string }>;
}

export interface TraceItem { agent: string; kind: 'tool' | 'delegate'; name: string; status: string; approval_id?: string }
export interface RunResult { reply: string; sources: Source[]; trace: TraceItem[]; approvalIds: string[] }
export interface RunParams { core: AiCore; llm: LlmProvider; base: BaseContext; maxSteps?: number; depth?: number }

const MAX_RESULT_CHARS = 8000;
const delegateSchema = z.object({ task: z.string().min(1).max(4000).describe('Úkol pro specialistu, vč. všech potřebných údajů od zákazníka') });

export async function runAgent(def: AgentDef, history: LlmMessage[], p: RunParams): Promise<RunResult> {
  const { core, llm, base } = p;
  const depth = p.depth ?? 0;
  const maxSteps = p.maxSteps ?? Number(await base.policy.get('agent.max_steps', 8));
  const sources: Source[] = [];
  const trace: TraceItem[] = [];
  const approvalIds: string[] = [];
  const messages: LlmMessage[] = [...history];

  const toolSpecs: LlmToolSpec[] = core.registry.llmSpec(def.tools);
  for (const [key, d] of Object.entries(def.delegates ?? {})) {
    const schema = z.toJSONSchema(delegateSchema) as Record<string, unknown>; delete schema.$schema;
    toolSpecs.push({ name: `delegate_${key}`, description: d.description, parameters: schema });
  }

  for (let step = 0; step < maxSteps; step++) {
    const resp = await llm.complete({ system: def.instructions, messages, tools: toolSpecs });
    // účetnictví spotřeby nesmí shodit konverzaci
    await recordLlmUsage(base.db, { request_id: base.requestId, conversation_id: base.conversationId, agent: def.name, model: resp.model, usage: resp.usage }).catch(() => {});
    if (!resp.tool_calls.length) {
      return { reply: resp.content ?? '', sources: dedupe(sources), trace, approvalIds };
    }
    messages.push({ role: 'assistant', content: resp.content, tool_calls: resp.tool_calls, raw: resp.raw });

    for (const call of resp.tool_calls) {
      let output: unknown;
      let args: unknown;
      try { args = JSON.parse(call.arguments || '{}'); } catch { args = undefined; }

      if (args === undefined) {
        output = { status: 'error', error: { code: 'bad_json', message: 'Argumenty nejsou platný JSON' } };
      } else if (call.name.startsWith('delegate_') && def.delegates?.[call.name.slice(9)]) {
        const key = call.name.slice(9);
        const parsed = delegateSchema.safeParse(args);
        if (!parsed.success || depth >= 2) {
          output = { status: 'error', error: { code: 'bad_delegate', message: 'Neplatná delegace' } };
        } else {
          const target = def.delegates![key].agent;
          await core.audit.record(base.db, { request_id: base.requestId, actor_type: base.actor.type, actor_id: base.actor.id,
            action: 'agent.delegate', tool: target.name, status: 'success', conversation_id: base.conversationId,
            input: redact({ from: def.name, task: parsed.data.task }) });
          const sub = await runAgent(target, [{ role: 'user', content: parsed.data.task }], { ...p, depth: depth + 1 });
          sources.push(...sub.sources); trace.push(...sub.trace); approvalIds.push(...sub.approvalIds);
          trace.push({ agent: def.name, kind: 'delegate', name: target.name, status: 'ok' });
          output = { status: 'ok', specialist: target.name, reply: sub.reply };
        }
      } else if (!def.tools.includes(call.name)) {
        await core.audit.record(base.db, { request_id: base.requestId, actor_type: base.actor.type, actor_id: base.actor.id,
          action: 'tool.call', tool: call.name, status: 'denied', error_code: 'tool_not_allowed', conversation_id: base.conversationId,
          output: { agent: def.name } });
        trace.push({ agent: def.name, kind: 'tool', name: call.name, status: 'denied' });
        output = { status: 'error', error: { code: 'tool_not_allowed', message: `Agent ${def.name} nesmí volat ${call.name}` } };
      } else {
        const res = await core.executor.execute(call.name, args, { ...base, requestId: base.requestId || randomUUID() });
        trace.push({ agent: def.name, kind: 'tool', name: call.name, status: res.status,
          approval_id: res.status === 'pending_approval' ? res.approval_id : undefined });
        if (res.status === 'ok') sources.push(...res.sources);
        if (res.status === 'pending_approval') approvalIds.push(res.approval_id);
        output = res;
      }
      let text = JSON.stringify(output);
      if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '…[zkráceno]';
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
  await core.audit.record(base.db, { request_id: base.requestId, actor_type: base.actor.type, actor_id: base.actor.id,
    action: 'agent.run', tool: def.name, status: 'error', error_code: 'max_steps', conversation_id: base.conversationId });
  return {
    reply: 'Omlouvám se, požadavek se mi nepodařilo dokončit. Předávám ho kolegovi z obchodního oddělení.',
    sources: dedupe(sources), trace, approvalIds,
  };
}

function dedupe(s: Source[]): Source[] {
  const seen = new Set<string>();
  return s.filter((x) => { const k = `${x.system}:${x.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
