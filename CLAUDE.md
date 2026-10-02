# CLAUDE.md – pravidla projektu BELETA AI SALES

Závazný základ pro každého, kdo (člověk i AI) v repozitáři pracuje.

## Co projekt je
Modul autonomního AI obchodního zástupce pro BELETA Plus s.r.o. Autonomní ≠ bez kontroly.
Podrobná specifikace: `MASTER_SPEC.md`. Architektura: `docs/AI_ARCHITECTURE.md`.

## Struktura
- `src/ai-core/` – doménově nezávislé jádro (tool executor, guardrails, schvalování, audit, agent runtime, LLM provider). **Nesmí importovat `src/beleta` ani `src/server`** (hlídá test). Určeno k znovupoužití pro CIHLICKY.CZ.
- `src/beleta/` – BELETA doména (katalog, ceny, sklad, kalkulace, CRM, nabídky, e-mail, znalostní báze, definice tools a agentů).
- `src/server/` – HTTP API (Fastify) + statické stránky.
- `agents/*.md` – prompty agentů (bez obchodních dat!).
- `db/core`, `db/beleta` – SQL migrace (PostgreSQL).
- `public/` – admin AI SALES a webový widget (vanilla JS, bez inline skriptů – CSP).
- `docs/` – dokumentace.

## Neporušitelná pravidla
1. AI NENÍ zdrojem cen, skladu, termínů, technických parametrů ani obchodních pravidel. Vždy tools/API → DB. Žádné hardcoded ceny/sklad v kódu ani promptech (hlídá test).
2. Jakákoli akce AI nad daty jde přes `ToolExecutor` (validace → scope → guard → handler v transakci → audit, fail-closed). Žádný přímý přístup agentů k DB.
3. SALES MANAGER nemá datové tools – jen delegace a `request_human_approval`.
4. Bez schválení člověkem AI nesmí: měnit ceny, dávat nestandardní slevy, měnit podmínky, potvrzovat nestandardní termíny, řešit právní spory/reklamace. Limity jsou v tabulce `ai_policies`, ne v kódu.
5. Osobní údaje nesmí do logů/auditu (`redact`). Audit je append-only s hash řetězem.
6. Změny DB jen novou migrací (nikdy neupravovat aplikovanou). Zachovat zpětnou kompatibilitu API; změny API zdokumentovat v `docs/AI_API.md`.
7. Nový tool = definice (zod schema `.strict()`, scope, risk, guard) + testy (úspěch, validace, autorizace, guard, audit) + záznam v `docs/AI_TOOLS.md`.
8. Úspěšný build není důkaz funkčnosti – spusťte `npm test` a `npm run typecheck`.

## Příkazy
`npm install --legacy-peer-deps` · `npm test` · `npm run typecheck` · `npm run dev` · `npm run seed`
