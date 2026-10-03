# Nasazení

## Požadavky
Node.js ≥ 22. Instalace: `npm ci --legacy-peer-deps` (npm 10 má s některými peer závislostmi problém). Spuštění: `npm start` (tsx; pro vyšší výkon lze doplnit build `tsc`).

## Konfigurace (`.env.example`)
| Proměnná | Význam |
|---|---|
| `NODE_ENV=production` | zapíná Secure cookie, HSTS, vyžaduje `INTERNAL_TOKEN` ≥ 24 znaků, vypíná demo seed |
| `PUBLIC_ORIGIN` | přesný origin administrace (kontrola Origin proti CSRF) |
| `DATABASE_URL` | PostgreSQL server (produkce, více instancí); bez něj se použije PGlite v `DATA_DIR` |
| `DATA_DIR` | adresář PGlite (perzistence); **zálohovat** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12 znaků) | vytvoří prvního admina, pokud žádný není |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `none`; prázdné = Anthropic, pokud je `ANTHROPIC_API_KEY`, jinak OpenAI |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (výchozí `claude-opus-5-5`; levnější `claude-sonnet-5-5`), `ANTHROPIC_EFFORT`, `ANTHROPIC_FALLBACKS` | Claude. Klíč: console.anthropic.com → API keys |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI (alternativa); bez jakéhokoli klíče chat vrací 503 |
| `LLM_PRICE_INPUT_USD_PER_MTOK`, `LLM_PRICE_OUTPUT_USD_PER_MTOK` (+ `_CACHE_READ_`, `_CACHE_WRITE_`) | volitelně ceny modelu pro odhad nákladů na stránce „Spotřeba AI“; bez nich se ukazují jen tokeny |
| `SEARCH_PROVIDER`, `BRAVE_SEARCH_API_KEY`, `SEARXNG_URL` | vyhledávač pro hledání zakázek: Brave Search API (klíč) nebo vlastní SearXNG (zdarma, JSON formát zapnutý); bez nich se vyhledávání nespustí |
| `INTERNAL_TOKEN` | n8n → `/api/internal/*` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | přímé odesílání e-mailů přes SMTP (transport `smtp`, má přednost před n8n; `SMTP_FROM` povinné) |
| `N8N_EMAIL_WEBHOOK` | pokud prázdné, e-maily se jen zapíší do `email_outbox` (transport `log`) |
| `WIDGET_FRAME_ANCESTORS` | weby (origins oddělené mezerou), které smějí vložit `/widget` do iframe; prázdné = nikdo |
| `TRUST_PROXY=true` | za reverzní proxy (správná IP pro rate limit) |
| `SEED_DEMO` | vynucení/zákaz demo dat |

Za reverzní proxy (TLS) – aplikace sama TLS neterminuje.

## Před ostrým provozem (povinné)
1. **Import skutečného katalogu, cen, skladu, kalkulačních pravidel a dopravy** z CSV: `npm run import -- <typ> <soubor.csv> [--dry-run]` (šablony a pravidla v `data/import-templates/README.md`), poté `npm run import -- deactivate-demo`. Přímý import z ERP zatím není.
2. Nahrát technickou dokumentaci do KB (`upsertDocument`, viz `src/beleta/knowledge.ts`); demo dokumenty nahradit.
3. **PostgreSQL server:** nastavte `DATABASE_URL=postgres://uživatel:heslo@host:5432/db` (má přednost před `DATA_DIR`/PGlite); migrace se aplikují při startu. Ověřeno na PostgreSQL 16 celou sadou testů (`TEST_DATABASE_URL=… npm test`) včetně souběžného zápisu auditu a rozhodování o schválení. Zálohy: `pg_dump`. Rate limiter je při `DATABASE_URL` sdílený přes tabulku `rate_limits` (pevná okna; při výpadku DB spadne na paměťový); s PGlite běží v paměti procesu.
4. Změnit výchozí hesla/tokeny; nastavit politiky v `/ai-sales/policies` (nechat konzervativní, tj. `discount.max_auto_pct=0`, `email.ai_auto_send=false`).
5. Zálohy DB + export posledního `hash` auditu do externího úložiště.
6. Ověřit na živém OpenAI klíči sadu reálných dotazů (viz AI_TESTING – manuální evaluace).

## n8n
Hotové workflow k importu jsou v `n8n/` (follow-upy, GDPR retence, denní vyhledávání zakázek; viz `n8n/README.md`, neověřeno proti živému n8n).
- **Cron follow-upů:** workflow *Schedule Trigger* (např. každých 15 min) → *HTTP Request* `POST {host}/api/internal/followups/run-due`, hlavička `X-Internal-Token`. Splatné e-mailové follow-upy připraví COMMUNICATION agent (e-mail jde na schválení), ostatní vytvoří úkol ve „Ke schválení“.
- **E-mail transport:** *Webhook* trigger přijme `{to, subject, body, ref}` → uzel SMTP/Gmail/Ecomail. Webhook URL do `N8N_EMAIL_WEBHOOK`. (Netestováno proti živému n8n.)

## Vyhledávání zakázek
1. Nastavte vyhledávač (`BRAVE_SEARCH_API_KEY` nebo `SEARXNG_URL`) a ceny modelu `LLM_PRICE_*`. 2. V `/ai-sales/policies` zadejte `scout.search_cost_usd_per_query` (cena dotazu u vašeho poskytovatele) a **stropy** `scout.monthly_budget_usd`, `scout.monthly_token_budget`, `scout.monthly_query_budget` (stropy upravujete kdykoli v administraci; běh se při dosažení kteréhokoli zastaví). 3. Vyzkoušejte ručně v `/ai-sales/opportunities` („Spustit vyhledávání teď“). 4. Až budete spokojeni, zapněte `scout.enabled` a naimportujte `n8n/scout-cron.json`. Dotazy, klíčová slova (`scout.facade_keywords`) a blokované domény se spravují v administraci. Nepřevedené nálezy se po `scout.retention_days` mažou.

## Profil webu (cihlovestavby.cz → beleta.cz)
Aktivní web určuje politika **`site.profile`** (administrace → Pravidla AI): `cihlovestavby` (výchozí; www.cihlovestavby.cz) nebo `beleta` (www.beleta.cz). Profil řídí značku a uvítání ve widgetu, kontext poradce (představuje se jako AI poradce daného webu) a **weby, které smějí vložit widget** (frame-ancestors). Přepnutí platí okamžitě bez restartu. Další web = nový záznam v `src/beleta/sites.ts`. `WIDGET_FRAME_ANCESTORS` v `.env` profil přepíše.

**Vložení na web:** na stránky vložte jediný řádek `<script src="https://<adresa-aplikace>/widget-assets/embed.js" defer></script>` (adresa = `PUBLIC_ORIGIN`, doporučeno subdoména typu `ai.cihlovestavby.cz` s HTTPS) – vznikne plovoucí tlačítko „Online poradce“, které otevře `/widget` v rámečku. Alternativně přímý `<iframe src="…/widget">`.

## Živá kontrola napojení
`npm run check:live` ověří klíč LLM, vyhledávač a stažení stránky; `npm run check:live -- --scout` navíc provede zkušební běh vyhledávání zakázek (1 dotaz, max. 3 stránky) do dočasné databáze v paměti a vypíše nálezy a spotřebu tokenů.

## Embed widgetu
Vložení řeší profil webu (viz výše); povolení platí jen pro `/widget`, administrace zůstává vždy nevkládatelná (`X-Frame-Options: DENY`).

## Docker a CI
`Dockerfile` (Node 22, data v `/data`, healthcheck `/healthz`): `docker build -t beleta-ai . && docker run -p 3000:3000 -v beleta-data:/data --env-file .env beleta-ai` (v produkci `NODE_ENV=production` vyžaduje `INTERNAL_TOKEN`, `PUBLIC_ORIGIN`, `ADMIN_*` při prvním startu). **Image nebyl sestaven** (v sandboxu neběží Docker daemon); ověřeno jen `npm ci --omit=dev` + `npm start` v produkčním režimu (`/healthz`, `/widget` OK). `.github/workflows/ci.yml`: typecheck, testy, `npm audit --audit-level=high` (běží až po pushi na GitHub).

## Provozní poznámky
Logy aplikace neobsahují PII; audit je v DB (`/ai-sales/activity`). Sledujte: počet `pending` schválení, chyby `llm_failure`, `max_steps`, stav integrity auditu.

## Lokální model (Ollama) – bez poplatků za API
```
ollama pull qwen2.5:14b            # model s podporou tool callingu (např. qwen2.5, llama3.1)
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama              # nesmí být prázdné, hodnota je libovolná
OPENAI_MODEL=qwen2.5:14b
OPENAI_TIMEOUT_MS=300000           # na CPU bývá odpověď pomalá
```
Ověřeno jen proti simulovanému OpenAI-kompatibilnímu serveru (`tests/openai-compatible.test.ts`); **skutečný model nebyl spuštěn** (síť sandboxu blokuje stahování). Očekávejte horší češtinu a méně spolehlivé volání nástrojů než u Claude/OpenAI; pravidla (slevy, schvalování, audit) tím nejsou dotčena. Před veřejným nasazením vyzkoušejte sadu reálných dotazů. Server musí běžet trvale (RAM/GPU).
