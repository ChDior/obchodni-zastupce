import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AnthropicProvider, OpenAIProvider, runAgent, toAnthropicMessages } from '../src/ai-core/index.js';
import type { Beleta } from '../src/beleta/bootstrap.js';
import { createLlmFromEnv } from '../src/server/llm-config.js';
import { ai, makeApp } from './helpers.js';
import { randomUUID } from 'node:crypto';

const fakeClient = (responses: any[], calls: any[] = []) => ({
  beta: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); const r = responses.shift(); if (r instanceof Error) throw r; return r; } } },
}) as any;

describe('AnthropicProvider', () => {
  test('sestaví požadavek (system, tools, fallbacks, effort) a parsuje tool_use + thinking do raw', async () => {
    const calls: any[] = [];
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Hned to zjistím.' }, { type: 'tool_use', id: 'tu1', name: 'get_price', input: { product: 'X' } }];
    const p = new AnthropicProvider({ model: 'claude-opus-5-5', effort: 'medium', client: fakeClient([{ content: blocks, stop_reason: 'tool_use' }], calls) });
    const r = await p.complete({ system: 'SYS', messages: [{ role: 'user', content: 'Cena?' }], tools: [{ name: 'get_price', description: 'd', parameters: { type: 'object', properties: {} } }] });
    expect(r.content).toBe('Hned to zjistím.'); expect(r.tool_calls).toEqual([{ id: 'tu1', name: 'get_price', arguments: '{"product":"X"}' }]); expect(r.raw).toEqual(blocks);
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', system: 'SYS', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(calls[0].tools[0]).toEqual({ name: 'get_price', description: 'd', input_schema: { type: 'object', properties: {} } });
    expect(calls[0].max_tokens).toBe(16000);
  });
  test('fallbacks lze vypnout; bez nástrojů se tools neposílá', async () => {
    const calls: any[] = [];
    const p = new AnthropicProvider({ model: 'm', fallbacks: false, client: fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }], calls) });
    await p.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(calls[0].fallbacks).toBeUndefined(); expect(calls[0].betas).toBeUndefined(); expect(calls[0].tools).toBeUndefined();
  });
  test('refusal -> bezpečná odpověď; chyba API -> bez těla chyby', async () => {
    const p = new AnthropicProvider({ model: 'm', client: fakeClient([{ content: [], stop_reason: 'refusal' }, Object.assign(new Error('SECRET conversation text'), { status: 429 })]) });
    const r = await p.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(r.content).toContain('kolegovi'); expect(r.tool_calls).toEqual([]);
    await expect(p.complete({ system: 's', messages: [], tools: [] })).rejects.toThrow(/^LLM HTTP 429$/);
  });
  test('převod zpráv: raw (thinking) se vrací beze změny, výsledky nástrojů se spojí do jedné user zprávy', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'a', name: 'n', input: {} }, { type: 'tool_use', id: 'b', name: 'n', input: {} }];
    const m = toAnthropicMessages([
      { role: 'user', content: 'Ahoj' },
      { role: 'assistant', content: null, tool_calls: [], raw },
      { role: 'tool', tool_call_id: 'a', content: '{"r":1}' }, { role: 'tool', tool_call_id: 'b', content: '{"r":2}' },
      { role: 'assistant', content: 'Hotovo', tool_calls: [{ id: 'c', name: 'n', arguments: '{bad' }] },
    ]);
    expect(m[1].content).toBe(raw);
    expect(m[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"r":1}' }, { type: 'tool_result', tool_use_id: 'b', content: '{"r":2}' }] });
    expect(m[3].content).toEqual([{ type: 'text', text: 'Hotovo' }, { type: 'tool_use', id: 'c', name: 'n', input: {} }]);
  });
});

describe('agent runtime s Claude providerem', () => {
  let app: Beleta;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  test('thinking bloky z kola s nástrojem se při dalším kroku posílají zpět beze změny; výsledek nástroje je tool_result', async () => {
    const calls: any[] = [];
    const rawTurn = [{ type: 'thinking', thinking: '', signature: 'SIG' }, { type: 'tool_use', id: 'toolu_1', name: 'delegate_product', input: { task: 'cena' } }];
    const rawSub1 = [{ type: 'thinking', thinking: '', signature: 'S2' }, { type: 'tool_use', id: 'toolu_2', name: 'get_price', input: { product: 'DEMO-TASKA-01' } }];
    const client = fakeClient([
      { content: rawTurn, stop_reason: 'tool_use' },                                     // manager
      { content: rawSub1, stop_reason: 'tool_use' },                                     // product agent
      { content: [{ type: 'text', text: '38 Kč' }], stop_reason: 'end_turn' },           // product agent final
      { content: [{ type: 'text', text: 'Taška stojí 38 Kč bez DPH.' }], stop_reason: 'end_turn' }, // manager final
    ], calls);
    const llm = new AnthropicProvider({ model: 'claude-opus-5-5', client });
    const r = await runAgent(app.agents.salesManager, [{ role: 'user', content: 'Kolik stojí taška?' }], { core: app.core, llm,
      base: { db: app.db, actor: ai, requestId: randomUUID(), policy: app.core.policy, deps: app.core.deps, now: app.core.now } });
    expect(r.reply).toContain('38');
    // 2. volání (product agent) i 3. volání: assistant zpráva s původními bloky včetně thinking
    expect(calls[2].messages[1].content).toEqual(rawSub1);
    expect(calls[2].messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2' });
    expect(calls[2].messages[2].content[0].content).toContain('amount_net');
    expect(calls[3].messages[1].content).toEqual(rawTurn);
    expect(r.sources.some((s) => s.system === 'pricing')).toBe(true);
    // manager vidí jen delegate_* + request_human_approval
    expect(calls[0].tools.map((t: any) => t.name).sort()).toEqual(['delegate_calculation', 'delegate_communication', 'delegate_lead', 'delegate_product', 'delegate_technical', 'request_human_approval']);
  });
});

describe('výběr poskytovatele z prostředí', () => {
  test('Haiku: neposílá effort ani fallbacks (nepodporuje je)', async () => {
    const { llm, label } = createLlmFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-haiku-4-5', ANTHROPIC_EFFORT: 'low' });
    expect(label).toBe('Claude (claude-haiku-4-5)');
    const calls: any[] = [];
    (llm as any).client = fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }], calls);
    await llm!.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(calls[0].model).toBe('claude-haiku-4-5');
    expect(calls[0].output_config).toBeUndefined(); expect(calls[0].fallbacks).toBeUndefined(); expect(calls[0].betas).toBeUndefined();
    expect(calls[0].thinking).toBeUndefined();
  });
  test('Anthropic má přednost, výchozí model, přepínač a chyby konfigurace', () => {
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }).llm).toBeInstanceOf(AnthropicProvider);
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: 'k' }).label).toBe('Claude (claude-opus-5-5)');
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).label).toBe('Claude (claude-sonnet-5-5)');
    expect(createLlmFromEnv({ OPENAI_API_KEY: 'o' }).llm).toBeInstanceOf(OpenAIProvider);
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', LLM_PROVIDER: 'openai' }).llm).toBeInstanceOf(OpenAIProvider);
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: 'k', LLM_PROVIDER: 'none' }).llm).toBeUndefined();
    expect(createLlmFromEnv({}).llm).toBeUndefined();
    expect(() => createLlmFromEnv({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
