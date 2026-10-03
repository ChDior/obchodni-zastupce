# Stav projektu a předání (pro nový chat)

## Kontext
BELETA AI SALES pro BELETA Plus s.r.o. – autonomní AI obchodní zástupce s lidskou kontrolou. Repo: `ChDior/obchodni-zastupce`, vývojová větev **`claude/beleta-ai-sales-audit-ek0oxg`** (hlavní větev `main` neexistuje, nebylo PR). Pravidla práce: `CLAUDE.md`, specifikace: `MASTER_SPEC.md` (sestavena ze zadání – žádné dodané podklady neexistovaly), architektura: `docs/AI_ARCHITECTURE.md`.

## Hotovo
- Projekt založen od nuly (repozitář byl prázdný): Node 22 + TypeScript + Fastify, PostgreSQL dialekt (PGlite pro MVP).
- `src/ai-core` (doménově nezávislé, test hlídá): ToolExecutor (validace → scope → guard → handler v tx + audit, fail-closed), human approval, audit s hash řetězem, redakce PII, agent runtime, LLM providery (**Claude/Anthropic SDK**, OpenAI-kompatibilní vč. Ollama).
- `src/beleta`: katalog, ceny, sklad, kalkulace (materiál/příslušenství/doprava), CRM, nabídky, e-mail (outbox, transport log/n8n), follow-upy, lokální znalostní báze; 18 tools; 6 agentů (SALES MANAGER bez datových nástrojů; prompty v `agents/*.md`).
- Admin `/ai-sales` (dashboard, leady, projekty, nabídky, follow-upy, ke schválení, aktivita AI, pravidla AI) + chat `/widget` + REST `/api/public/*`.
- E-mail: transport SMTP (`SMTP_*` v `.env`, má přednost před n8n), reset hesla admina (`npm run reset-password -- <email> <heslo>`; zneplatní relace).
- PDF nabídek (pdfkit, font DejaVu v `assets/fonts`, tlačítko v detailu nabídky) a GDPR (export, výmaz, retence – REST + `docs/AI_API.md`; UI tlačítka pro výmaz zatím nejsou).
- 2FA (TOTP + záložní kódy) a správa uživatelů (`/ai-sales/users`, `/ai-sales/security`).
- Import CSV (`npm run import`, šablony `data/import-templates/`, REST `/import/:typ`) a logování tokenů (`ai_llm_usage`, stránka Spotřeba AI; ceny volitelně `LLM_PRICE_*`).
- Nabídky: číslování po letech, odeslání e-mailem s PDF přílohou (tool i tlačítko v administraci); stránka Zákazníci s GDPR tlačítky; vložení widgetu (`WIDGET_FRAME_ANCESTORS`); `Dockerfile`, CI (`.github/workflows`), n8n workflow v `n8n/` (Docker/CI/n8n neověřeno).
- Znalostní báze v administraci (`/ai-sales/kb`): vytvoření, úprava, načtení z .md/.txt, deaktivace, smazání; PDF s textovou vrstvou (náhled textu ke kontrole před uložením; sken bez OCR nejde). Opraveno: prázdné tělo s `Content-Type: application/json` (POST/DELETE z UI bez těla) už nevrací 400.
- Katalog v administraci (`/ai-sales/products`): úprava produktů, cen (s historií), skladu, parametrů a kalkulačního pravidla, jen admin, auditováno.
- **Profil webu** (`site.profile`: cihlovestavby | beleta; přepnutí v administraci), `embed.js` pro vložení widgetu na web, `npm run check:live` (živá kontrola klíčů).
- **Administrace česky** (Poptávky, Následné kontakty, české stavy) a **ruční zadávání** zákazníků, poptávek, projektů a nabídek.
- **Aktivní vyhledávání zakázek** (OPPORTUNITY SCOUT; stránka Příležitosti): Brave/SearXNG, bezpečné stahování + robots.txt, citace i kontakty ověřuje server, návrh úvodního e-mailu k odeslání člověkem, měsíční stropy upravitelné v administraci, n8n cron `n8n/scout-cron.json`. Neověřeno živě (potřeba klíč vyhledávače a ANTHROPIC klíč).
- Sdílený rate limiter v DB (aktivní při `DATABASE_URL`).
- PostgreSQL server (`DATABASE_URL`, adaptér `openPg`): sada testů prošla na PG 16; při tom opraveno rozvětvení hash řetězu auditu při souběhu (advisory lock).
- 174 testů (2 z nich jen s `TEST_DATABASE_URL`), typecheck čistý. Dokumentace v `docs/` (CURRENT_ARCHITECTURE, GAP_ANALYSIS, AI_*).
- Windows: `start-windows.cmd` + `scripts/setup-windows.ps1` (instalace, `.env`, spuštění). Uživatel ho úspěšně spustil a je přihlášený do administrace.

## Rozhodnutí
- Výchozí LLM Claude; model v `ANTHROPIC_MODEL` (`claude-opus-5-5` výchozí v kódu; doporučen `claude-sonnet-5-5`, nejlevnější `claude-haiku-4-5` – u něj se effort/fallbacks neposílají). Výběr poskytovatele: `LLM_PROVIDER` / dostupné klíče.
- Limity pravomocí AI jsou v tabulce `ai_policies` (sleva 0 %, e-maily AI ke schválení, práh nabídky 500 000 Kč bez DPH…), ne v kódu.
- Odhad nákladů (hrubý, ±2×): typická konverzace ~0,9 USD Opus / ~0,4 Sonnet / ~0,15–0,25 Haiku; 20 USD ≈ 20–25 / 45–60 / 100–130 konverzací.

## Nedokončeno / další kroky
1. **Klíč Anthropic** v `.env` (`ANTHROPIC_API_KEY`) → první zkouška chatu na živém API, sada reálných dotazů, doladění promptů (zatím jen simulovaní klienti).
2. **Reálná data**: katalog, ceny, sklad, kalkulační pravidla, doprava (zatím jen ukázková `DEMO-*`), technická dokumentace do KB; ukázkové dokumenty jsou smyšlené. Import z CSV je hotový, chybí jen napojení na ERP a samotná reálná data.
3. **Hosting**: uživatel má Vedos webhosting „No limit" (sdílený; Node.js pravděpodobně nepodporuje – ověřit u podpory). Alternativa: VPS (Vedos/Hetzner) pod `ai.<doména>`. Nasazení zatím neexistuje; potřeba: Node 22, trvalý proces, HTTPS proxy (nginx), `NODE_ENV=production`, `PUBLIC_ORIGIN`, silný `INTERNAL_TOKEN`.
4. (hotovo) PostgreSQL server (`DATABASE_URL`) včetně sdíleného rate limiteru.
4b. **Vyhledávání zakázek – zprovoznit:** nastavit `BRAVE_SEARCH_API_KEY` (nebo `SEARXNG_URL`), `LLM_PRICE_*`, cenu dotazu a stropy v pravidlech, ručně vyzkoušet a doladit klíčová slova/dotazy; teprve poté zapnout `scout.enabled`. Právně prověřit oslovování (§ 7 zák. 480/2004, GDPR).
5. (hotovo) Logování spotřeby tokenů – po prvním živém běhu doplňte `LLM_PRICE_*` podle ceníku modelu.
6. Dále: n8n workflow (cron follow-upů, e-mail webhook), n8n cron pro `/api/internal/gdpr/retention`, OpenAI File Search adaptér pro KB, embed widgetu (X-Frame-Options), automatizované UI testy.
7. Ověřit na živém Windows `start-windows.cmd` ještě po změnách (opraveno: nutno rozbalit ZIP před spuštěním).

## Známá omezení
PGlite = jedna instance (pro více instancí použijte `DATABASE_URL`); rate limiter in-memory jen u PGlite; lokální KB lexikální; OpenAI/Ollama/n8n/SMTP netestováno živě; Ollama v sandboxu nešlo stáhnout (síťová politika), ověřeno jen simulovaným serverem.

Úplný přehled toho, co ještě chybí vůči `MASTER_SPEC.md`: `docs/BELETA_AI_GAP_ANALYSIS.md` (sekce „Co stále chybí“).
