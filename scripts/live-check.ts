// Živá kontrola napojení: npm run check:live [-- --scout]
//  1) LLM (klíč, model, spotřeba tokenů)   2) vyhledávač   3) stažení a vyhodnocení jedné stránky
//  --scout: zkušební běh celého vyhledávání zakázek do DOČASNÉ databáze v paměti (1 dotaz, max. 3 stránky) – nic se neukládá do vaší DB
import { bootstrap } from '../src/beleta/bootstrap.js';
import { pricingFromEnv } from '../src/ai-core/index.js';
import { createLlmFromEnv } from '../src/server/llm-config.js';
import { searchFromEnv } from '../src/beleta/search.js';
import { safeFetch, decodeBody, htmlToText } from '../src/beleta/net-safe.js';

const env = process.env;
const ok = (m: string) => console.log('  ✔ ' + m);
const bad = (m: string) => { console.log('  ✘ ' + m); process.exitCode = 1; };
const { llm, label: llmLabel } = createLlmFromEnv(env);
const { provider: search, label: searchLabel } = searchFromEnv(env);

console.log(`\n1) LLM: ${llmLabel}`);
if (!llm) bad('LLM není nastaveno (ANTHROPIC_API_KEY nebo OPENAI_API_KEY v .env)');
else {
  try {
    const r = await llm.complete({ system: 'Odpovídej jednou krátkou větou česky.', messages: [{ role: 'user', content: 'Napiš slovo „funguje“.' }], tools: [] });
    ok(`odpověď: „${(r.content ?? '').trim().slice(0, 80)}“; model ${r.model ?? '?'}; tokeny vstup/výstup ${r.usage?.input_tokens ?? '?'}/${r.usage?.output_tokens ?? '?'}`);
  } catch (e) { bad(`volání LLM selhalo: ${(e as Error).message} (zkontrolujte klíč, model a síť)`); }
}

console.log(`\n2) Vyhledávač: ${searchLabel}`);
let first: { url: string; title: string } | undefined;
if (!search) bad('vyhledávač není nastaven (BRAVE_SEARCH_API_KEY nebo SEARXNG_URL v .env)');
else {
  try {
    const res = await search.search('fasáda obkladové pásky veřejná zakázka', 5);
    if (!res.length) bad('vyhledávač vrátil 0 výsledků'); else { ok(`${res.length} výsledků`); res.slice(0, 3).forEach((r) => console.log(`     - ${r.title.slice(0, 70)} – ${r.url}`)); first = res[0]; }
  } catch (e) { bad(`vyhledávání selhalo: ${(e as Error).message} (zkontrolujte klíč / adresu)`); }
}

console.log('\n3) Stažení stránky');
if (first) {
  try {
    const d = await safeFetch(first.url, { userAgent: 'BeletaScoutBot/1.0 (live-check)' });
    const text = /html|xml/i.test(d.contentType) ? htmlToText(decodeBody(d.body, d.contentType)) : decodeBody(d.body, d.contentType);
    ok(`${first.url} → ${d.contentType.split(';')[0]}, ${text.length} znaků textu`);
  } catch (e) { console.log(`  • stažení první stránky neprošlo (${(e as Error).message}) – u některých webů je to normální (robots, blokace)`); }
} else console.log('  • přeskočeno (bez výsledků hledání)');

if (process.argv.includes('--scout')) {
  console.log('\n4) Zkušební běh vyhledávání zakázek (dočasná DB v paměti)');
  if (!llm || !search) bad('chybí LLM nebo vyhledávač');
  else {
    const app = await bootstrap({ llm, search, llmPricing: pricingFromEnv(env), seedDemo: false });
    await app.db.query(`delete from scout_queries where id not in (select id from scout_queries order by created_at limit 1)`);
    await app.core.policy.set('scout.max_queries_per_run', 1, 'live-check'); await app.core.policy.set('scout.max_pages_per_run', 3, 'live-check');
    const r = await app.scout({ trigger: 'manual', by: 'live-check' });
    console.log(`  běh: dotazů ${r.queries}, stránek ${r.pages}, vyhodnoceno ${r.analysed}, nalezeno ${r.found}${r.skipped ? ', přeskočeno: ' + r.skipped : ''}${r.note ? ' – ' + r.note : ''}`);
    const ops = await app.db.query<any>('select title, organization, stage, fit_score, url, evidence from opportunities order by fit_score desc');
    ops.forEach((o) => console.log(`  ★ [${o.fit_score}] ${o.title} (${o.organization ?? '?'}, ${o.stage})\n      ${o.url}\n      „${o.evidence.slice(0, 160)}“`));
    const u = (await app.db.query<any>('select coalesce(sum(input_tokens),0)::int i, coalesce(sum(output_tokens),0)::int o from ai_llm_usage'))[0];
    console.log(`  spotřeba tokenů: vstup ${u.i}, výstup ${u.o}`);
    ok('zkušební běh dokončen'); await app.close();
  }
}
console.log(process.exitCode ? '\nNěkteré kontroly selhaly (viz ✘).' : '\nVše potřebné funguje.');
