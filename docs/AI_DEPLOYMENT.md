# Nasazení

## Požadavky
Node.js ≥ 22. Instalace: `npm ci --legacy-peer-deps` (npm 10 má s některými peer závislostmi problém). Spuštění: `npm start` (tsx; pro vyšší výkon lze doplnit build `tsc`).

## Konfigurace (`.env.example`)
| Proměnná | Význam |
|---|---|
| `NODE_ENV=production` | zapíná Secure cookie, HSTS, vyžaduje `INTERNAL_TOKEN` ≥ 24 znaků, vypíná demo seed |
| `PUBLIC_ORIGIN` | přesný origin administrace (kontrola Origin proti CSRF) |
| `DATA_DIR` | adresář PGlite (perzistence); **zálohovat** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12 znaků) | vytvoří prvního admina, pokud žádný není |
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `none`; prázdné = Anthropic, pokud je `ANTHROPIC_API_KEY`, jinak OpenAI |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (výchozí `claude-opus-5-5`; levnější `claude-sonnet-5-5`), `ANTHROPIC_EFFORT`, `ANTHROPIC_FALLBACKS` | Claude. Klíč: console.anthropic.com → API keys |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI (alternativa); bez jakéhokoli klíče chat vrací 503 |
| `LLM_PRICE_INPUT_USD_PER_MTOK`, `LLM_PRICE_OUTPUT_USD_PER_MTOK` (+ `_CACHE_READ_`, `_CACHE_WRITE_`) | volitelně ceny modelu pro odhad nákladů na stránce „Spotřeba AI“; bez nich se ukazují jen tokeny |
| `INTERNAL_TOKEN` | n8n → `/api/internal/*` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | přímé odesílání e-mailů přes SMTP (transport `smtp`, má přednost před n8n; `SMTP_FROM` povinné) |
| `N8N_EMAIL_WEBHOOK` | pokud prázdné, e-maily se jen zapíší do `email_outbox` (transport `log`) |
| `TRUST_PROXY=true` | za reverzní proxy (správná IP pro rate limit) |
| `SEED_DEMO` | vynucení/zákaz demo dat |

Za reverzní proxy (TLS) – aplikace sama TLS neterminuje.

## Před ostrým provozem (povinné)
1. **Import skutečného katalogu, cen, skladu, kalkulačních pravidel a dopravy** z CSV: `npm run import -- <typ> <soubor.csv> [--dry-run]` (šablony a pravidla v `data/import-templates/README.md`), poté `npm run import -- deactivate-demo`. Přímý import z ERP zatím není.
2. Nahrát technickou dokumentaci do KB (`upsertDocument`, viz `src/beleta/knowledge.ts`); demo dokumenty nahradit.
3. **PostgreSQL server:** PGlite je jednoprocesové. Implementujte `Db` nad `pg` (`query`, `tx`, `close`; transakce přes dedikované spojení) a `audit.record` nechte běžet v transakci – SQL je standardní PostgreSQL. Do doby, než adaptér vznikne, provozujte jednu instanci.
4. Změnit výchozí hesla/tokeny; nastavit politiky v `/ai-sales/policies` (nechat konzervativní, tj. `discount.max_auto_pct=0`, `email.ai_auto_send=false`).
5. Zálohy DB + export posledního `hash` auditu do externího úložiště.
6. Ověřit na živém OpenAI klíči sadu reálných dotazů (viz AI_TESTING – manuální evaluace).

## n8n
- **Cron follow-upů:** workflow *Schedule Trigger* (např. každých 15 min) → *HTTP Request* `POST {host}/api/internal/followups/run-due`, hlavička `X-Internal-Token`. Splatné e-mailové follow-upy připraví COMMUNICATION agent (e-mail jde na schválení), ostatní vytvoří úkol ve „Ke schválení“.
- **E-mail transport:** *Webhook* trigger přijme `{to, subject, body, ref}` → uzel SMTP/Gmail/Ecomail. Webhook URL do `N8N_EMAIL_WEBHOOK`. (Netestováno proti živému n8n.)

## Embed widgetu
`/widget` je samostatná stránka s `X-Frame-Options: DENY`. Pro vložení do webu: buď odkaz/otevření v novém okně, nebo upravit `frame-ancestors`/`X-Frame-Options` v `src/server/app.ts` na povolené domény.

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
