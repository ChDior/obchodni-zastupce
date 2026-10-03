# Stav projektu a předání (pro nový chat)

## Kontext
BELETA AI SALES pro BELETA Plus s.r.o. – autonomní AI obchodní zástupce s lidskou kontrolou. Repo: `ChDior/obchodni-zastupce`, vývojová větev **`claude/beleta-ai-sales-audit-ek0oxg`** (hlavní větev `main` neexistuje, nebylo PR). Pravidla práce: `CLAUDE.md`, specifikace: `MASTER_SPEC.md` (sestavena ze zadání – žádné dodané podklady neexistovaly), architektura: `docs/AI_ARCHITECTURE.md`.

## Hotovo
- Projekt založen od nuly (repozitář byl prázdný): Node 22 + TypeScript + Fastify, PostgreSQL dialekt (PGlite pro MVP).
- `src/ai-core` (doménově nezávislé, test hlídá): ToolExecutor (validace → scope → guard → handler v tx + audit, fail-closed), human approval, audit s hash řetězem, redakce PII, agent runtime, LLM providery (**Claude/Anthropic SDK**, OpenAI-kompatibilní vč. Ollama).
- `src/beleta`: katalog, ceny, sklad, kalkulace (materiál/příslušenství/doprava), CRM, nabídky, e-mail (outbox, transport log/n8n), follow-upy, lokální znalostní báze; 18 tools; 6 agentů (SALES MANAGER bez datových nástrojů; prompty v `agents/*.md`).
- Admin `/ai-sales` (dashboard, leady, projekty, nabídky, follow-upy, ke schválení, aktivita AI, pravidla AI) + chat `/widget` + REST `/api/public/*`.
- E-mail: transport SMTP (`SMTP_*` v `.env`, má přednost před n8n), reset hesla admina (`npm run reset-password -- <email> <heslo>`; zneplatní relace).
- 109 testů, typecheck čistý. Dokumentace v `docs/` (CURRENT_ARCHITECTURE, GAP_ANALYSIS, AI_*).
- Windows: `start-windows.cmd` + `scripts/setup-windows.ps1` (instalace, `.env`, spuštění). Uživatel ho úspěšně spustil a je přihlášený do administrace.

## Rozhodnutí
- Výchozí LLM Claude; model v `ANTHROPIC_MODEL` (`claude-opus-5-5` výchozí v kódu; doporučen `claude-sonnet-5-5`, nejlevnější `claude-haiku-4-5` – u něj se effort/fallbacks neposílají). Výběr poskytovatele: `LLM_PROVIDER` / dostupné klíče.
- Limity pravomocí AI jsou v tabulce `ai_policies` (sleva 0 %, e-maily AI ke schválení, práh nabídky 500 000 Kč bez DPH…), ne v kódu.
- Odhad nákladů (hrubý, ±2×): typická konverzace ~0,9 USD Opus / ~0,4 Sonnet / ~0,15–0,25 Haiku; 20 USD ≈ 20–25 / 45–60 / 100–130 konverzací.

## Nedokončeno / další kroky
1. **Klíč Anthropic** v `.env` (`ANTHROPIC_API_KEY`) → první zkouška chatu na živém API, sada reálných dotazů, doladění promptů (zatím jen simulovaní klienti).
2. **Reálná data**: katalog, ceny, sklad, kalkulační pravidla, doprava (zatím jen ukázková `DEMO-*`), technická dokumentace do KB; ukázkové dokumenty jsou smyšlené. Chybí import z ERP/CSV.
3. **Hosting**: uživatel má Vedos webhosting „No limit" (sdílený; Node.js pravděpodobně nepodporuje – ověřit u podpory). Alternativa: VPS (Vedos/Hetzner) pod `ai.<doména>`. Nasazení zatím neexistuje; potřeba: Node 22, trvalý proces, HTTPS proxy (nginx), `NODE_ENV=production`, `PUBLIC_ORIGIN`, silný `INTERNAL_TOKEN`.
4. **PostgreSQL server** místo PGlite (adaptér `Db` nad `pg` není hotový) před provozem na více instancích.
5. Logování reálné spotřeby tokenů a ceny do auditu/administrace (navrženo, neimplementováno).
6. Dále: n8n workflow (cron follow-upů, e-mail webhook), PDF nabídek, GDPR (výmaz/retence), 2FA a správa uživatelů, OpenAI File Search adaptér pro KB, embed widgetu (X-Frame-Options), automatizované UI testy.
7. Ověřit na živém Windows `start-windows.cmd` ještě po změnách (opraveno: nutno rozbalit ZIP před spuštěním).

## Známá omezení
PGlite = jedna instance; rate limiter in-memory; lokální KB lexikální; OpenAI/Ollama/n8n/SMTP netestováno živě; Ollama v sandboxu nešlo stáhnout (síťová politika), ověřeno jen simulovaným serverem.
