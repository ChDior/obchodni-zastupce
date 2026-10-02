import type { Db, PolicyReader } from './types.js';

/** Obchodní/AI politiky v DB (měnitelné jen člověkem). Žádné hardcoded limity v kódu agentů. */
export class PolicyStore implements PolicyReader {
  constructor(private db: Db) {}
  async get<T = unknown>(key: string, fallback: T): Promise<T> {
    const r = await this.db.query<{ value: T }>('select value from ai_policies where key=$1', [key]);
    return r.length ? r[0].value : fallback;
  }
  /** Pro tools běžící v transakci. */
  withDb(db: Db): PolicyReader { return new PolicyStore(db); }
  async list() { return this.db.query('select key, value, description, updated_at, updated_by from ai_policies order by key'); }
  async set(key: string, value: unknown, by: string) {
    const r = await this.db.query('update ai_policies set value=$2::jsonb, updated_at=now(), updated_by=$3 where key=$1 returning key', [key, JSON.stringify(value), by]);
    if (!r.length) throw new Error(`Unknown policy ${key}`);
  }
}
