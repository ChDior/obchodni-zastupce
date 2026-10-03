import { DomainError, type Db } from '../ai-core/index.js';
import { norm } from './util.js';

/** Rozhraní znalostní báze. Lokální implementace = Postgres + lexikální skórování.
 *  Produkčně lze vyměnit za OpenAI File Search / vector store se stejným rozhraním. */
export interface KnowledgeHit { document_id: string; title: string; ord: number; content: string; score: number; category: string }
export interface KnowledgeProvider { search(db: Db, query: string, limit: number): Promise<KnowledgeHit[]> }

export function chunkText(text: string, max = 900): string[] {
  // odstavce; příliš dlouhý odstavec (typicky text z PDF bez prázdných řádků) se dělí po řádcích / větách / slovech
  const split = (p: string): string[] => {
    if (p.length <= max) return [p];
    const parts = p.split(/\n|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
    const out: string[] = []; let cur = '';
    for (const part of parts) {
      if (part.length > max) { if (cur) { out.push(cur); cur = ''; } for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max)); continue; }
      if (cur && (cur + ' ' + part).length > max) { out.push(cur); cur = part; } else cur = cur ? cur + ' ' + part : part;
    }
    if (cur) out.push(cur);
    return out;
  };
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).flatMap(split);
  const out: string[] = []; let cur = '';
  for (const p of paras) {
    if (cur && (cur + '\n\n' + p).length > max) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

export async function upsertDocument(db: Db, d: { title: string; content: string; category?: string; source?: string }) {
  const r = await db.query<any>(
    `insert into kb_documents (title, content, category, source) values ($1,$2,$3,$4)
     on conflict (title) do update set content=excluded.content, category=excluded.category, source=excluded.source, active=true
     returning id`, [d.title, d.content, d.category ?? 'general', d.source ?? 'manual']);
  const id = r[0].id as string;
  await db.query('delete from kb_chunks where document_id=$1', [id]);
  let ord = 0;
  for (const c of chunkText(d.content)) await db.query('insert into kb_chunks (document_id, ord, content, norm) values ($1,$2,$3,$4)', [id, ord++, c, norm(c)]);
  return id;
}

export class LocalKnowledge implements KnowledgeProvider {
  async search(db: Db, query: string, limit: number): Promise<KnowledgeHit[]> {
    const terms = [...new Set(norm(query).split(/[^a-z0-9]+/).filter((t) => t.length > 2))];
    if (!terms.length) return [];
    const rows = await db.query<any>(
      `select c.document_id, c.ord, c.content, c.norm, d.title, d.category from kb_chunks c
       join kb_documents d on d.id = c.document_id where d.active`);
    const df = new Map<string, number>();
    for (const t of terms) df.set(t, rows.filter((r) => r.norm.includes(t)).length);
    const hits = rows.map((r) => {
      let score = 0;
      for (const t of terms) {
        const tf = r.norm.split(t).length - 1;
        if (tf) score += (1 + Math.log(tf)) * Math.log(1 + rows.length / (1 + (df.get(t) ?? 0)));
      }
      if (norm(r.title).split(/[^a-z0-9]+/).some((w: string) => terms.includes(w))) score *= 1.3;
      return { document_id: r.document_id, title: r.title, ord: r.ord, content: r.content, category: r.category, score: Math.round(score * 100) / 100 };
    }).filter((h) => h.score > 0);
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/* ---------- správa dokumentů (administrace) ---------- */
export async function listDocuments(db: Db) {
  return db.query(`select d.id, d.title, d.category, d.source, d.active, d.updated_at, length(d.content)::int as chars,
    (select count(*)::int from kb_chunks c where c.document_id=d.id) as chunks from kb_documents d order by d.title`);
}
export async function getDocument(db: Db, id: string) {
  return (await db.query<any>('select id, title, category, source, active, content, updated_at from kb_documents where id=$1', [id]))[0] ?? null;
}
/** Vytvoření (id=null) nebo úprava dokumentu včetně přegenerování úseků. Název je unikátní. */
export async function saveDocument(db: Db, id: string | null, d: { title: string; content: string; category?: string; active?: boolean }) {
  return db.tx(async (t) => {
    const dup = await t.query<any>('select id from kb_documents where title=$1', [d.title]);
    if (dup.length && dup[0].id !== id) throw new DomainError('title_exists', 'Dokument s tímto názvem už existuje');
    let docId: string;
    if (id) {
      const r = await t.query<any>(`update kb_documents set title=$2, content=$3, category=$4, active=coalesce($5, active), updated_at=now() where id=$1 returning id`,
        [id, d.title, d.content, d.category ?? 'general', d.active ?? null]);
      if (!r.length) throw new DomainError('not_found', 'Dokument neexistuje');
      docId = r[0].id;
    } else {
      docId = (await t.query<any>(`insert into kb_documents (title, content, category, source, active) values ($1,$2,$3,'admin',$4) returning id`, [d.title, d.content, d.category ?? 'general', d.active ?? true]))[0].id;
    }
    await t.query('delete from kb_chunks where document_id=$1', [docId]);
    let ord = 0;
    for (const c of chunkText(d.content)) await t.query('insert into kb_chunks (document_id, ord, content, norm) values ($1,$2,$3,$4)', [docId, ord++, c, norm(c)]);
    return { id: docId, chunks: ord };
  });
}
export async function setDocumentActive(db: Db, id: string, active: boolean) {
  const r = await db.query('update kb_documents set active=$2, updated_at=now() where id=$1 returning id', [id, active]);
  if (!r.length) throw new DomainError('not_found', 'Dokument neexistuje');
}
export async function deleteDocument(db: Db, id: string) {
  const r = await db.query('delete from kb_documents where id=$1 returning id', [id]); // úseky mizí kaskádou
  if (!r.length) throw new DomainError('not_found', 'Dokument neexistuje');
}
