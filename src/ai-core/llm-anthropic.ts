import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './llm.js';

export interface AnthropicConfig {
  /** Výchozí: ANTHROPIC_API_KEY z prostředí (SDK). */
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /** low | medium | high | xhigh | max – bez hodnoty platí výchozí hodnota modelu. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Server-side fallback při odmítnutí bezpečnostními klasifikátory (jen Claude API). Výchozí zapnuto. */
  fallbacks?: boolean;
  timeoutMs?: number;
  /** Pro testy. */
  client?: Pick<Anthropic, 'beta'>;
}

const REFUSAL_TEXT = 'Na tento dotaz nemohu odpovědět. Předám ho kolegovi z obchodního oddělení.';

/** Claude (Anthropic Messages API) s tool use. Stejné rozhraní jako OpenAIProvider. */
export class AnthropicProvider implements LlmProvider {
  private client: Pick<Anthropic, 'beta'>;
  constructor(private cfg: AnthropicConfig) {
    this.client = cfg.client ?? new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params: any = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens ?? 16_000,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
      ...(this.cfg.fallbacks === false ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    };
    let res: any;
    try {
      res = await (this.client as any).beta.messages.create(params);
    } catch (err) {
      // tělo chyby záměrně nepropagujeme (může obsahovat obsah konverzace)
      throw new Error(`LLM HTTP ${(err as { status?: number }).status ?? 'error'}`);
    }
    const blocks: any[] = res.content ?? [];
    if (res.stop_reason === 'refusal') return { content: REFUSAL_TEXT, tool_calls: [] };
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tool_calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    return { content: text || null, tool_calls, raw: blocks };
  }
}

/** Převod interního formátu zpráv na Messages API. Souvislé výsledky nástrojů jdou do jedné user zprávy. */
export function toAnthropicMessages(messages: LlmMessage[]): Array<{ role: 'user' | 'assistant'; content: any }> {
  const out: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content ?? '' });
    else if (m.role === 'assistant') {
      if (m.raw) { out.push({ role: 'assistant', content: m.raw }); continue; } // thinking bloky beze změny
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: safeJson(c.arguments) });
      out.push({ role: 'assistant', content: blocks.length ? blocks : '' });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b: any) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}
function safeJson(s: string): unknown { try { return JSON.parse(s || '{}'); } catch { return {}; } }
