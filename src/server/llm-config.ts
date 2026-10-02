import { AnthropicProvider, OpenAIProvider, type LlmProvider } from '../ai-core/index.js';

/** Výběr LLM poskytovatele z prostředí. LLM_PROVIDER=anthropic|openai|none; bez něj: Anthropic, pokud je klíč, jinak OpenAI. */
export function createLlmFromEnv(env: Record<string, string | undefined>): { llm?: LlmProvider; label: string } {
  const choice = (env.LLM_PROVIDER ?? '').toLowerCase();
  if (choice === 'none') return { label: 'vypnuto' };
  const useAnthropic = choice === 'anthropic' || (choice === '' && !!env.ANTHROPIC_API_KEY);
  const useOpenAI = choice === 'openai' || (choice === '' && !useAnthropic && !!env.OPENAI_API_KEY);
  if (useAnthropic) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic vyžaduje ANTHROPIC_API_KEY');
    const model = env.ANTHROPIC_MODEL ?? 'claude-opus-5-5';
    // Haiku 4.5 nezná parametr effort ani server-side fallbacks (API by vrátilo 400) – u něj se nikdy neposílají.
    const isHaiku = /haiku/i.test(model);
    const effort = isHaiku ? undefined : (env.ANTHROPIC_EFFORT as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined);
    const fallbacks = !isHaiku && env.ANTHROPIC_FALLBACKS !== 'false';
    return { llm: new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model, effort, fallbacks }), label: `Claude (${model})` };
  }
  if (useOpenAI) {
    if (!env.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai vyžaduje OPENAI_API_KEY');
    const model = env.OPENAI_MODEL ?? 'gpt-4.1';
    const timeoutMs = env.OPENAI_TIMEOUT_MS ? Number(env.OPENAI_TIMEOUT_MS) : undefined; // lokální modely na CPU bývají pomalé
    return { llm: new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model, baseUrl: env.OPENAI_BASE_URL, timeoutMs }), label: `OpenAI-kompatibilní (${model} @ ${env.OPENAI_BASE_URL ?? 'api.openai.com'})` };
  }
  return { label: 'vypnuto – chybí ANTHROPIC_API_KEY / OPENAI_API_KEY' };
}
