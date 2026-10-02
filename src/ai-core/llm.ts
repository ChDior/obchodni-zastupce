export interface LlmToolCall { id: string; name: string; arguments: string }
export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  /** Neprůhledný obsah specifický pro provider (např. thinking bloky Claude) – musí se vracet beze změny. */
  raw?: unknown;
}
export interface LlmToolSpec { name: string; description: string; parameters: object }
export interface LlmRequest { system: string; messages: LlmMessage[]; tools: LlmToolSpec[] }
export interface LlmResponse { content: string | null; tool_calls: LlmToolCall[]; raw?: unknown }

/** Provider-agnostní rozhraní. AI nikdy nedrží obchodní data – jen volá nástroje. */
export interface LlmProvider { complete(req: LlmRequest): Promise<LlmResponse> }

export interface OpenAIConfig { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** OpenAI Chat Completions s function calling (bez SDK závislosti; vyměnitelné za Agents SDK). */
export class OpenAIProvider implements LlmProvider {
  constructor(private cfg: OpenAIConfig) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const f = this.cfg.fetchImpl ?? fetch;
    const messages: unknown[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (m.role === 'assistant') {
        messages.push({ role: 'assistant', content: m.content,
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) });
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' });
      } else messages.push({ role: 'user', content: m.content ?? '' });
    }
    const res = await f(`${this.cfg.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model, messages, temperature: 0.2,
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`); // tělo odpovědi záměrně nelogujeme
    const j: any = await res.json();
    const msg = j.choices?.[0]?.message;
    return {
      content: msg?.content ?? null,
      tool_calls: (msg?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  }
}

/** Skriptovaný provider pro testy a offline vývoj. */
export class ScriptedProvider implements LlmProvider {
  public requests: LlmRequest[] = [];
  constructor(private script: Array<LlmResponse | ((req: LlmRequest) => LlmResponse)>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...req, messages: [...req.messages] }); // snapshot (runtime messages dál mutuje)
    const next = this.script.shift();
    if (!next) return { content: 'KONEC SKRIPTU', tool_calls: [] };
    return typeof next === 'function' ? next(req) : next;
  }
}
