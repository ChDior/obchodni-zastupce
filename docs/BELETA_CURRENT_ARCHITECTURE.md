# BELETA – současná architektura

## 1. Výsledek auditu výchozího stavu
Při zahájení práce byl repozitář `ChDior/obchodni-zastupce` **zcela prázdný** (žádný commit, žádná větev, žádný z dokumentů uvedených v zadání). Na pokyn zadavatele („stavíme od nuly“) nebyl systém auditován, ale **založen**. Tento dokument proto popisuje stav po založení (baseline v1), ne převzatý systém. Dokumenty `MASTER_SPEC.md` a `CLAUDE.md` byly sestaveny ze zadání (viz poznámka v `MASTER_SPEC.md`).

Odpovědi na auditní otázky:

| # | Téma | Stav |
|---|------|------|
| 1 | Framework | Žádný předchozí. Zvoleno: Node.js ≥ 22, TypeScript (ESM), Fastify 5, zod 4 |
| 2 | Frontend | Vanilla JS + CSS, bez build kroku, strict CSP (žádné inline skripty/styly). Admin `/ai-sales`, widget `/widget` |
| 3 | Backend | Fastify API (`src/server`), AI core (`src/ai-core`), BELETA doména (`src/beleta`) |
| 4 | Databáze | PostgreSQL dialekt. MVP běží na PGlite (PostgreSQL ve WASM, perzistence v `DATA_DIR`); produkčně doporučen PostgreSQL server (rozhraní `Db`, viz AI_DEPLOYMENT) |
| 5 | Administrace | Nová sekce AI SALES; uživatelé `admin_users`, role admin/sales/viewer |
| 6 | Produkty | `products` (+ `attributes` JSONB pro technické parametry), `search_text` pro vyhledávání bez diakritiky |
| 7 | Ceny | `prices` (ceníky, platnost od–do, DPH). Bez platné ceny = chyba, AI cenu nesmí odhadnout |
| 8 | Kalkulačka | `calc_rules` (spotřeba/m², ztráty, balení), `accessory_rules`, `shipping_zones/rates`; funkce `src/beleta/calc.ts` |
| 9 | Objednávky | **Neexistují** – MVP končí návrhem nabídky (`quotes`); objednávkový proces je mimo rozsah |
| 10 | Přihlášení admin | scrypt hash hesel, DB session (SHA-256 hash tokenu), HttpOnly+SameSite=Strict cookie, rate limit, audit |
| 11 | API | viz `AI_API.md` |
| 12 | Externí služby | OpenAI (LLM), n8n (e-mail webhook, cron follow-upů). Nic jiného |
| 13 | Obrázky | Neřešeno (katalog neobsahuje obrázky); doporučeno object storage + URL v `products.attributes` |
| 14 | SEO | Neřešeno – web/e-shop není součástí tohoto repozitáře; admin a widget mají `noindex` / nejsou indexovatelné |
| 15 | Bezpečnost | viz `AI_SECURITY.md` |
| 16 | Deployment | `npm start`, Docker/CI nejsou; viz `AI_DEPLOYMENT.md` |
| 17 | Testy | Vitest, 94+ testů (viz `AI_TESTING.md`) |

## 2. Architektura (stav po založení)
```
 zákazník ─► /widget ─► POST /api/public/chat ─► SALES MANAGER ─┬► PRODUCT / TECHNICAL / CALCULATION / LEAD / COMMUNICATION
                                                                │            (whitelist nástrojů na agenta)
 obchodník ─► /ai-sales (admin) ─► /api/admin/*                 ▼
 n8n ─► POST /api/internal/followups/run-due      ┌───────────── ToolExecutor (ai-core) ─────────────┐
                                                  │ validace → scope → guard → handler(tx) + audit   │
                                                  └───────┬───────────────┬──────────────────┬───────┘
                                                          ▼               ▼                  ▼
                                                   BELETA doména      approvals          audit log
                                              (katalog/ceny/sklad/   (ai_approvals)   (hash řetěz)
                                               kalkulace/CRM/…)             │
                                                          └──────── PostgreSQL ────────────┘
```
Hranice: `ai-core` nezná BELETA (test). LLM vidí jen JSON schémata nástrojů a jejich výstupy; obchodní data nejsou v promptech.

## 3. Databáze
Viz `AI_DATABASE.md` (24 tabulek ve dvou migračních sadách `db/core`, `db/beleta`).

## 4. Integrační body
- **OpenAI**: `OpenAIProvider` (Chat Completions + function calling), vyměnitelné rozhraním `LlmProvider`.
- **n8n**: (a) `N8N_EMAIL_WEBHOOK` – odesílání e-mailů; (b) cron → `POST /api/internal/followups/run-due` s `X-Internal-Token`.
- **ERP/sklad/ceník**: zatím jen demo seed. Integrace = import do `products/prices/stock` (CSV/API) – nutný krok před ostrým provozem.
- **Znalostní báze**: `KnowledgeProvider` (lokální lexikální vyhledávání; připraveno na OpenAI File Search).

## 5. Potenciální problémy / omezení baseline
1. PGlite je jednoprocesové, jedno spojení – pro více instancí je nutný PostgreSQL server + adaptér (`Db` rozhraní je připraveno, adaptér není hotový).
2. Demo katalog a ukázkové dokumenty jsou smyšlené – nelze je použít v produkci.
3. Rate limiter je in-memory (neškáluje na více instancí).
4. `OpenAIProvider` je testován jen proti mocku, ne živému API; n8n webhook transport také.
5. Lokální KB je lexikální, ne sémantická; kvalita u velké dokumentace bude nižší než vector store.
6. Chybí GDPR nástroje (export/výmaz zákazníka, retence konverzací).
7. Widget nelze vložit do cizí stránky přes iframe (`X-Frame-Options: DENY`); pro embed je třeba upravit `frame-ancestors`.
8. Nabídka nemá PDF výstup; „odeslání“ nabídky = lidská změna stavu + e-mail.

## 6. Doporučené místo pro integraci AI
Jediné bezpečné místo je **vrstva tools** (`ToolExecutor`) – AI nikdy nesahá do DB, API ani e-mailu mimo ni. Nové schopnosti (další produkty, ERP, telefon) se přidávají jako nové tools/agenti, ne jako nová práva agentů.
