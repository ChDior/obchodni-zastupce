import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bootstrap, type Beleta } from '../src/beleta/bootstrap.js';
import { createLlmFromEnv } from '../src/server/llm-config.js';
import { makeApp } from './helpers.js';

/** Falešný OpenAI-kompatibilní server (stejné rozhraní jako Ollama /v1): ověřuje konfiguraci pro lokální modely bez stahování modelu. */
let server: Server; let base = ''; let app: Beleta; const seen: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body); seen.push({ url: req.url, auth: req.headers.authorization, body: j });
      const isManager = j.messages[0].content.includes('SALES MANAGER');
      const lastTool = [...j.messages].reverse().find((m: any) => m.role === 'tool');
      let message: any;
      if (isManager && !lastTool) message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegate_product', arguments: '{"task":"cena tašky Klasik"}' } }] };
      else if (isManager) message = { role: 'assistant', content: 'Podle produktového specialisty: ' + JSON.parse(lastTool.content).reply };
      else if (!lastTool) message = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'get_price', arguments: '{"product":"DEMO-TASKA-01"}' } }] };
      else message = { role: 'assistant', content: 'Cena je ' + JSON.parse(lastTool.content).data.amount_net + ' Kč bez DPH.' };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  app = await makeApp();
});
afterAll(async () => { server.close(); await app.close(); });

test('chat přes OPENAI_BASE_URL (Ollama styl): delegace, nástroj, cena z DB, zdroje', async () => {
  const { llm, label } = createLlmFromEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'ollama', OPENAI_BASE_URL: base, OPENAI_MODEL: 'qwen2.5:14b', OPENAI_TIMEOUT_MS: '5000' });
  expect(label).toContain('qwen2.5:14b');
  const b = await bootstrap({ db: app.db, llm, seedDemo: false, now: app.core.now });
  const r = await b.chat({ message: 'Kolik stojí taška Klasik?' });
  expect(r.reply).toContain('Cena je 38 Kč');
  expect(r.sources.some((s) => s.system === 'pricing')).toBe(true);
  expect(seen.every((s) => s.url === '/v1/chat/completions' && s.auth === 'Bearer ollama' && s.body.model === 'qwen2.5:14b')).toBe(true);
  expect(seen[0].body.tools.some((t: any) => t.function.name === 'delegate_product')).toBe(true);
  expect(seen[0].body.tools.some((t: any) => t.function.name === 'create_quote')).toBe(false); // manager datové nástroje nevidí
});
