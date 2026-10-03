import { describe, expect, test } from 'vitest';
import { AnthropicProvider, OpenAIProvider, ScriptedProvider, pricingFromEnv, usageReport } from '../src/ai-core/index.js';
import { buildServer } from '../src/server/app.js';
import { bootstrap } from '../src/beleta/bootstrap.js';

const res = (usage: any) => ({ content: 'Dobrý den', tool_calls: [], usage, model: 'm-test' });

describe('spotřeba tokenů', () => {
  test('Anthropic provider vrací usage i model', async () => {
    const client: any = { beta: { messages: { create: async () => ({ model: 'claude-x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }) } } };
    const r = await new AnthropicProvider({ model: 'm', client }).complete({ system: 's', messages: [], tools: [] });
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2 }); expect(r.model).toBe('claude-x');
  });
  test('OpenAI provider mapuje usage', async () => {
    const fetchImpl: any = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 4 } }) });
    const r = await new OpenAIProvider({ apiKey: 'k', model: 'gpt', fetchImpl }).complete({ system: 's', messages: [], tools: [] });
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 4 });
  });
  test('chat zapíše spotřebu; report bez cen vrací cost null, s cenami spočítá', async () => {
    const llm = new ScriptedProvider([res({ input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 })]);
    const app = await bootstrap({ llm, now: () => new Date('2026-10-02T10:00:00Z'), admin: { email: 'admin@test.cz', password: 'test-password-123' } });
    const r = await app.chat({ message: 'Dobrý den' });
    const rows = await app.db.query<any>('select * from ai_llm_usage');
    expect(rows.length).toBe(1); expect(rows[0]).toMatchObject({ agent: 'SALES_MANAGER', model: 'm-test', input_tokens: 1000, output_tokens: 500, conversation_id: r.conversation_id });
    const noPrice = await usageReport(app.db, 30);
    expect(noPrice.total).toMatchObject({ input: 1000, output: 500, calls: 1, cost_usd: null }); expect(noPrice.conversations).toBe(1);
    const priced = await usageReport(app.db, 30, pricingFromEnv({ LLM_PRICE_INPUT_USD_PER_MTOK: '3', LLM_PRICE_OUTPUT_USD_PER_MTOK: '15' }));
    expect(priced.total.cost_usd).toBeCloseTo(0.0105, 6); expect(priced.avg_cost_per_conversation_usd).toBeCloseTo(0.0105, 6);
    expect(priced.by_agent[0].agent).toBe('SALES_MANAGER');
    // endpoint
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
    expect((await srv.inject('/api/admin/ai-sales/usage')).statusCode).toBe(401);
    const l = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' }, payload: { email: 'admin@test.cz', password: 'test-password-123' } });
    const u = await srv.inject({ url: '/api/admin/ai-sales/usage?days=7', headers: { cookie: String(l.headers['set-cookie']).split(';')[0] } });
    expect(u.statusCode).toBe(200); expect(u.json().days).toBe(7);
    await srv.close(); await app.close();
  });
});
