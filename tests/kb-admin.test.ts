import { describe, expect, test } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { createUser } from '../src/beleta/auth.js';
import { makeApp, ok, run } from './helpers.js';

async function setup() {
  const app = await makeApp();
  const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false });
  const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
  const login = async (email: string, password: string) => String((await srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email, password } })).headers['set-cookie']).split(';')[0];
  const cookie = await login('admin@test.cz', 'test-password-123');
  const call = (method: string, url: string, payload?: unknown, c = cookie) => srv.inject({ method: method as any, url: `/api/admin/ai-sales${url}`, headers: { ...H, cookie: c }, payload: payload as any });
  return { app, srv, call, login };
}
const DOC = { title: 'Montáž hřebenáče', category: 'technical', content: 'Hřebenáč se kotví nerezovými vruty.\n\nMinimální přesah hřebenáče je 50 mm.' };

describe('správa znalostní báze v administraci', () => {
  test('vytvoření → AI ho najde a cituje; úprava přegeneruje úseky; deaktivace a smazání ho skryjí', async () => {
    const { app, srv, call } = await setup();
    const c = await call('POST', '/kb', DOC); expect(c.statusCode).toBe(200); expect(c.json().chunks).toBe(1);
    const id = c.json().id;
    const hit: any = ok(await run(app, 'search_knowledge', { query: 'přesah hřebenáče' }));
    expect(JSON.stringify(hit)).toContain('Montáž hřebenáče');
    expect((await call('POST', '/kb', DOC)).statusCode).toBe(409);
    const u = await call('PUT', `/kb/${id}`, { ...DOC, content: DOC.content + '\n\n' + 'x'.repeat(1000) + '\n\nNový odstavec o difuzní fólii.' });
    expect(u.statusCode).toBe(200); expect(u.json().chunks).toBeGreaterThan(1);
    expect(JSON.stringify(ok(await run(app, 'search_knowledge', { query: 'difuzní fólie' })))).toContain('Montáž hřebenáče');
    await call('POST', `/kb/${id}/active`, { active: false });
    expect(JSON.stringify(ok(await run(app, 'search_knowledge', { query: 'přesah hřebenáče' })))).not.toContain('Montáž hřebenáče');
    const list = (await call('GET', '/kb')).json(); expect(list.find((d: any) => d.id === id)).toMatchObject({ active: false });
    expect((await call('DELETE', `/kb/${id}`)).statusCode).toBe(200);
    expect((await call('GET', `/kb/${id}`)).statusCode).toBe(404);
    expect((await app.db.query("select 1 from kb_chunks where document_id=$1", [id])).length).toBe(0);
    const acts = (await app.db.query<any>("select action from ai_audit_log where action like 'kb.%' order by id")).map((r) => r.action);
    expect(acts).toEqual(['kb.create', 'kb.update', 'kb.active', 'kb.delete']);
    await srv.close();
  });
  test('validace a oprávnění', async () => {
    const { app, srv, call, login } = await setup();
    expect((await call('POST', '/kb', { title: 'a', content: 'krátké' })).statusCode).toBe(400);
    expect((await call('POST', '/kb', { ...DOC, extra: 1 })).statusCode).toBe(400);
    expect((await call('GET', '/kb/not-uuid')).statusCode).toBe(400);
    expect((await call('PUT', '/kb/00000000-0000-0000-0000-000000000000', DOC)).statusCode).toBe(404);
    await createUser(app.db, { email: 'sales@test.cz', role: 'sales', password: 'dlouhe-heslo-123' });
    const sc = await login('sales@test.cz', 'dlouhe-heslo-123');
    expect((await call('GET', '/kb', undefined, sc)).statusCode).toBe(200);
    expect((await call('POST', '/kb', DOC, sc)).statusCode).toBe(403);
    expect((await srv.inject('/api/admin/ai-sales/kb')).statusCode).toBe(401);
    await srv.close();
  });
});

describe('tělo požadavku', () => {
  test('prázdné tělo s application/json projde, neplatný JSON je 400', async () => {
    const { srv, call } = await setup();
    expect((await call('POST', '/users', undefined)).statusCode).toBe(400); // validace, ne chyba parseru
    const r = await srv.inject({ method: 'POST', url: '/api/admin/login', headers: { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' }, payload: '{bad' });
    expect(r.statusCode).toBe(400);
    await srv.close();
  });
});

import PDFDocument from 'pdfkit';
import { chunkText } from '../src/beleta/knowledge.js';
import { pdfToText } from '../src/beleta/pdf-text.js';

const makePdf = (lines: string[]): Promise<Buffer> => new Promise((resolve) => {
  const d = new PDFDocument(); const out: Buffer[] = [];
  d.on('data', (c: Buffer) => out.push(c)); d.on('end', () => resolve(Buffer.concat(out)));
  d.font('assets/fonts/DejaVuSans.ttf');
  lines.forEach((l, i) => { if (i) d.addPage(); if (l) d.text(l); });
  d.end();
});

describe('PDF do znalostní báze', () => {
  test('extrakce textu s češtinou přes více stran; sken/nesmysl se odmítne', async () => {
    const pdf = await makePdf(['Montáž hřebenáče: přesah je 50 mm.', 'Řezání tašek na hřebeni.']);
    const r = await pdfToText(pdf);
    expect(r.pages).toBe(2); expect(r.text).toContain('hřebenáče'); expect(r.text).toContain('Řezání tašek');
    await expect(pdfToText(Buffer.from('tohle není pdf'))).rejects.toMatchObject({ code: 'validation_error' });
    await expect(pdfToText(await makePdf(['']))).rejects.toMatchObject({ code: 'no_text' });
  });
  test('chunkText dělí dlouhý souvislý text (PDF bez prázdných řádků) na úseky', () => {
    const long = Array.from({ length: 120 }, (_, i) => `Věta číslo ${i} o montáži.`).join(' ');
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(2); expect(chunks.every((c) => c.length <= 900)).toBe(true);
    expect(chunks.join(' ')).toContain('Věta číslo 119');
  });
  test('REST: /kb/extract jen admin, vrátí text; pak uložení a vyhledání AI', async () => {
    const { app, srv, call, login } = await setup();
    const pdf = await makePdf(['Technický list: minimální sklon střechy pro tašku Klasik je 22 stupňů.']);
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/pdf' };
    const cookie = await login('admin@test.cz', 'test-password-123');
    const ex = await srv.inject({ method: 'POST', url: '/api/admin/ai-sales/kb/extract', headers: { ...H, cookie }, payload: pdf });
    expect(ex.statusCode).toBe(200); expect(ex.json().text).toContain('minimální sklon');
    expect((await srv.inject({ method: 'POST', url: '/api/admin/ai-sales/kb/extract', headers: { ...H, cookie }, payload: Buffer.from('xxxxxxxxxxxxxxxxxxxx') })).statusCode).toBe(400);
    await createUser(app.db, { email: 'sales2@test.cz', role: 'sales', password: 'dlouhe-heslo-123' });
    const sc = await login('sales2@test.cz', 'dlouhe-heslo-123');
    expect((await srv.inject({ method: 'POST', url: '/api/admin/ai-sales/kb/extract', headers: { ...H, cookie: sc }, payload: pdf })).statusCode).toBe(403);
    expect((await call('POST', '/kb', { title: 'Technický list Klasik', content: ex.json().text })).statusCode).toBe(200);
    expect(JSON.stringify(ok(await run(app, 'search_knowledge', { query: 'minimální sklon střechy' })))).toContain('Technický list Klasik');
    await srv.close();
  });
});
