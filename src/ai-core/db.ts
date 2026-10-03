import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { Db } from './types.js';

class PgliteDb implements Db {
  constructor(private pg: PGlite, private runner?: { query: PGlite['query'] }) {}
  private get exec() { return this.runner ?? this.pg; }
  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.exec.query<T>(sql, params as any[]);
    return r.rows;
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.runner) return fn(this); // už jsme v transakci – spojíme do vnější
    return this.pg.transaction(async (t) => fn(new PgliteDb(this.pg, t as any)));
  }
  async close() { await this.pg.close(); }
}

// node-pg: int8 → number (bigserial id, count), date → řetězec RRRR-MM-DD (bez posunu časovou zónou serveru)
const pgTypes = { getTypeParser: (oid: number, fmt?: any) => (oid === 20 ? (v: string) => Number(v) : oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, fmt)) } as any;

class PgDb implements Db {
  constructor(private pool: pg.Pool, private client?: pg.PoolClient) {}
  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await (this.client ?? this.pool).query({ text: sql, values: params as any[], types: pgTypes })).rows as T[];
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // už jsme v transakci – spojíme do vnější
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await fn(new PgDb(this.pool, c));
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  async close() { await this.pool.end(); }
}

/** PostgreSQL server (produkce, více instancí). `schema` = izolovaný schéma (testy); `dropSchemaOnClose` ho při zavření smaže. */
export async function openPg(url: string, opts: { schema?: string; dropSchemaOnClose?: boolean; max?: number } = {}): Promise<Db> {
  if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error('Neplatný název schématu');
  const base = new pg.Pool({ connectionString: url, max: 2 });
  if (opts.schema) await base.query(`create schema if not exists ${opts.schema}`);
  await base.end();
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10, ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}) });
  pool.on('error', () => { /* odpojení nečinného spojení nesmí shodit proces */ });
  const db = new PgDb(pool);
  await db.query('select 1');
  if (!opts.dropSchemaOnClose || !opts.schema) return db;
  const close = db.close.bind(db);
  db.close = async () => { await db.query(`drop schema ${opts.schema} cascade`).catch(() => {}); await close(); };
  return db;
}

/** dataDir prázdné = in-memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true }); // PGlite vytvoří jen poslední úroveň
  const pg = new PGlite(dataDir || undefined);
  await pg.waitReady;
  return new PgliteDb(pg);
}

/** Aplikuje *.sql z adresářů (v pořadí), každý soubor jednou. Název = "<dir>/<soubor>". */
export async function migrate(db: Db, dirs: string[]): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied: string[] = [];
  for (const dir of dirs) {
    const label = dir.split('/').filter(Boolean).slice(-1)[0];
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const name = `${label}/${f}`;
      const done = await db.query('select 1 from schema_migrations where name=$1', [name]);
      if (done.length) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await db.tx(async (t) => {
        await execMulti(t, sql);
        await t.query('insert into schema_migrations(name) values ($1)', [name]);
      });
      applied.push(name);
    }
  }
  return applied;
}

async function execMulti(db: Db, sql: string) {
  // PGlite .query() akceptuje jen jeden příkaz; skripty s funkcemi ($$) dělíme na hranici ";\n" mimo $$ bloky.
  for (const stmt of splitSql(sql)) await db.query(stmt);
}

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (const line of sql.split('\n')) {
    const stripped = line.replace(/--.*$/, '');
    cur += stripped + '\n';
    const marks = (stripped.match(/\$\$/g) ?? []).length;
    if (marks % 2 === 1) inDollar = !inDollar;
    if (!inDollar && stripped.trimEnd().endsWith(';')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
