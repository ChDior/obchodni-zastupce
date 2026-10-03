/** Jednoduchý in-memory limiter (okno). Pro více instancí nahradit Redisem – viz docs/AI_DEPLOYMENT.md. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  /** true = povoleno */
  take(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(t); this.hits.set(key, arr);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export interface Limiter { take(key: string): boolean | Promise<boolean> }

/** Sdílený limiter v DB (pevná okna, jeden atomický upsert). Při výpadku DB spadne na paměťový limiter (dostupnost > přesnost). */
export class DbRateLimiter implements Limiter {
  private fallback: RateLimiter;
  private n = 0;
  constructor(private db: { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }, private name: string, private max: number, private windowMs: number) {
    this.fallback = new RateLimiter(max, windowMs);
  }
  async take(key: string): Promise<boolean> {
    const w = Math.max(1, Math.round(this.windowMs / 1000));
    try {
      const r = await this.db.query<{ hits: number }>(
        `insert into rate_limits (name, key, window_start, hits)
         values ($1, $2, to_timestamp(floor(extract(epoch from now()) / $3::int) * $3::int), 1)
         on conflict (name, key, window_start) do update set hits = rate_limits.hits + 1 returning hits`, [this.name, key.slice(0, 300), w]);
      if (++this.n % 200 === 0) this.db.query(`delete from rate_limits where window_start < now() - interval '1 day'`).catch(() => {});
      return Number(r[0].hits) <= this.max;
    } catch { return this.fallback.take(key); }
  }
}
