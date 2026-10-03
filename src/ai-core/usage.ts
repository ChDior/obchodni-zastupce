import type { Db } from './types.js';
import type { LlmUsage } from './llm.js';

export interface LlmPricing { input?: number; output?: number; cache_read?: number; cache_write?: number } // USD za 1 mil. tokenů

/** Ceny z prostředí (LLM_PRICE_*_USD_PER_MTOK). Nic se nepředpokládá: bez cen je cena null. */
export function pricingFromEnv(env: Record<string, string | undefined>): LlmPricing {
  const n = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { input: n(env.LLM_PRICE_INPUT_USD_PER_MTOK), output: n(env.LLM_PRICE_OUTPUT_USD_PER_MTOK),
    cache_read: n(env.LLM_PRICE_CACHE_READ_USD_PER_MTOK), cache_write: n(env.LLM_PRICE_CACHE_WRITE_USD_PER_MTOK) };
}

export async function recordLlmUsage(db: Db, r: { request_id?: string; conversation_id?: string; agent: string; model?: string; usage?: LlmUsage }) {
  if (!r.usage) return;
  const u = r.usage;
  await db.query(
    `insert into ai_llm_usage (request_id, conversation_id, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.request_id ?? null, r.conversation_id ?? null, r.agent, r.model ?? null, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_tokens ?? 0, u.cache_write_tokens ?? 0]);
}

const costOf = (t: { input: number; output: number; cache_read: number; cache_write: number }, p: LlmPricing): number | null => {
  if (p.input == null || p.output == null) return null;
  return (t.input * p.input + t.output * p.output + t.cache_read * (p.cache_read ?? p.input) + t.cache_write * (p.cache_write ?? p.input)) / 1e6;
};

/** Souhrn za posledních N dní: celkem, po dnech, po agentech; odhad ceny jen pokud jsou nastaveny ceny. */
export async function usageReport(db: Db, days: number, pricing: LlmPricing = {}) {
  const d = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const agg = `sum(input_tokens)::float8 input, sum(output_tokens)::float8 output, sum(cache_read_tokens)::float8 cache_read, sum(cache_write_tokens)::float8 cache_write, count(*)::int calls`;
  const where = `ts > now() - ($1 || ' days')::interval`;
  const fin = (r: any) => ({ ...r, cost_usd: costOf(r, pricing) });
  const total = (await db.query<any>(`select coalesce(sum(input_tokens),0)::float8 input, coalesce(sum(output_tokens),0)::float8 output, coalesce(sum(cache_read_tokens),0)::float8 cache_read,
    coalesce(sum(cache_write_tokens),0)::float8 cache_write, count(*)::int calls from ai_llm_usage where ${where}`, [String(d)]))[0];
  const convs = (await db.query<any>(`select count(distinct conversation_id)::int n from ai_llm_usage where ${where} and conversation_id is not null`, [String(d)]))[0].n;
  const by_day = (await db.query<any>(`select to_char(date_trunc('day', ts), 'YYYY-MM-DD') as day, ${agg} from ai_llm_usage where ${where} group by 1 order by 1 desc`, [String(d)])).map(fin);
  const by_agent = (await db.query<any>(`select agent, ${agg} from ai_llm_usage where ${where} group by 1 order by 2 desc`, [String(d)])).map(fin);
  const t = fin(total);
  return { days: d, total: t, conversations: convs, avg_cost_per_conversation_usd: t.cost_usd != null && convs ? t.cost_usd / convs : null, pricing_configured: pricing.input != null && pricing.output != null, by_day, by_agent };
}
