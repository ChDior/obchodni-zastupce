import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** dataDir prázdné = in-memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
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
