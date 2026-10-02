# AI architektura (návrh a implementace)

## Principy
1. **AI je rozhodovací vrstva, ne zdroj dat.** Ceny, sklad, termíny, technické parametry a pravidla vždy přicházejí z nástrojů → DB. Prompty (`agents/*.md`) neobsahují obchodní data (test).
2. **Jediná brána:** `ToolExecutor` – validace (zod `.strict()`) → autorizace (scope aktéra) → guard (deterministická pravidla, nikdy LLM) → handler v DB transakci spolu se zápisem auditu (fail-closed).
3. **Autonomní ≠ bez kontroly.** AI ví, co smí (scope + whitelist nástrojů agenta), co nesmí (guard `deny`), kdy se ptát člověka (guard `approval`), odkud má informaci (`sources` v každém výsledku) a co udělala (audit).
4. **Znovupoužitelné jádro:** `src/ai-core` je bez BELETA závislostí; doména dodává tools, agenty a `deps`.

## Volba technologií (a odchylky od preferencí zadání)
| Oblast | Volba | Poznámka |
|---|---|---|
| LLM | **Claude (Anthropic SDK, výchozí `claude-opus-5-5`)** nebo OpenAI Chat Completions – obojí za rozhraním `LlmProvider`, přepínač `LLM_PROVIDER`. Vlastní tenký runtime s tool use | **Ne OpenAI Agents SDK ani Claude Agent SDK**: potřebujeme plnou kontrolu nad guardrails/auditem na každém volání a offline testovatelnost (`ScriptedProvider`). Přechod na Agents SDK je možný – tools jsou čistá schémata + handler |
| Backend | Node 22 + TypeScript + Fastify | Žádný existující backend |
| DB | PostgreSQL dialekt; MVP PGlite | Pro produkci PostgreSQL server |
| Automatizace | n8n přes webhook + cron → interní endpoint | |
| Znalostní báze | `KnowledgeProvider`; lokální implementace | OpenAI File Search/vector store = další adaptér (nehotovo) |
| CRM | Integrované (`customers/leads/projects/quotes/followups`) | |

## Tok požadavku (chat)
`POST /api/public/chat` → rate limit → `chat()` načte historii → `runAgent(SALES_MANAGER)` → LLM volá `delegate_*` → specialista (vlastní whitelist) volá tools → `ToolExecutor` → výsledky + zdroje zpět → odpověď. Audit: každé volání nástroje, každá delegace, každé schválení.

## C. Doporučená architektura – shrnutí požadovaných výstupů
**D. Změny DB** – nová databáze (žádná změna existující). Viz `AI_DATABASE.md`.
**E. Nové API** – viz `AI_API.md` (veřejné čtení + chat, admin AI SALES, interní n8n).
**F. AI tools** – 17 požadovaných + `search_knowledge` (viz `AI_TOOLS.md`).
**G. AI agenti** – SALES MANAGER, PRODUCT, TECHNICAL, CALCULATION, LEAD, COMMUNICATION (viz `AI_AGENTS.md`).
**H. UI** – sekce AI SALES: dashboard, `/ai-sales/leads|projects|quotes|followups|approvals|activity`, navíc `/ai-sales/policies` (limity AI) a veřejný `/widget`.
**I. Rizika**
| Riziko | Dopad | Mitigace | Zbytkové |
|---|---|---|---|
| Halucinace cen/termínů | Právní/finanční | Žádná data v promptu, ceny jen z tools, nabídka cenu nepřijímá, `sources` | Model může číslo v textu přepsat – doporučeno nasazovat s lidskou kontrolou nabídek před odesláním |
| Prompt injection (poznámky, dokumenty, zprávy) | Neoprávněná akce | Výstupy nástrojů označeny jako data; guardy a whitelisty jsou nezávislé na LLM; test | Texty mohou zákazníka zmást |
| Zneužití veřejného chatu (náklady, spam leadů) | Náklady, špína v CRM | Rate limit, limit zpráv, limit vytváření zákazníků, max kroků agenta | In-memory limiter |
| Únik PII | GDPR | `redact`, žádné PII v auditu; `approvals.input` s PII přístupné jen přihlášeným | Chybí retence/výmaz |
| Neprovozuschopná DB (PGlite) | Dostupnost | PostgreSQL server pro produkci | Adaptér nehotový |
| Chybná data v katalogu/pravidlech | Chybné nabídky | Import s validací, kontrola člověkem | Závisí na datech |
| Právní rámec e-mailů/telefonu | Sankce | Cold calling a hromadné e-maily záměrně vypnuty | — |
| Náklady LLM | Rozpočet | max kroků, krátká historie, rate limit | Chybí měření nákladů |
**J. Implementační plán**
1. ✅ Baseline (tento repozitář): AI core, tools, agenti, guardrails, admin, testy, dokumentace.
2. Import skutečného katalogu/cen/skladu z ERP, ověření kalkulačních pravidel s obchodem.
3. PostgreSQL server + adaptér `Db`, CI, Docker, zálohy.
4. Ostrý test s OpenAI klíčem na reálných dotazech (evaluace odpovědí, doladění promptů), měření nákladů.
5. n8n workflow (cron follow-upů, e-mail transport), SMTP/Ecomail.
6. Reálná KB: nahrání dokumentace, případně OpenAI File Search adaptér.
7. Pilot s lidským schvalováním všech nabídek/e-mailů → postupné uvolňování politik.
8. Pozdější fáze: PDF nabídky, GDPR nástroje, hlas/telefon, outbound.
9. Druhé nasazení (CIHLICKY.CZ): vytáhnout `ai-core` do balíčku (npm workspace), přidat doménu `cihlicky`.

## LLM poskytovatelé (Claude / OpenAI)
`src/ai-core/llm-anthropic.ts` (`AnthropicProvider`, oficiální `@anthropic-ai/sdk`) a `OpenAIProvider` implementují stejné rozhraní; výběr v `src/server/llm-config.ts`. Bezpečnost nezávisí na poskytovateli – guardy a whitelisty jsou v kódu.
Specifika Claude:
- Výchozí model `claude-opus-5-5` (u této řady nelze vypnout thinking; hloubku řídí `ANTHROPIC_EFFORT`). Pro nižší cenu `ANTHROPIC_MODEL=claude-sonnet-5-5`.
- **Thinking bloky** z kola s nástroji se vracejí API beze změny (`LlmMessage.raw`); mezi chatovými zprávami se historie ukládá jako čistý text (thinking se odstraňuje ze všech starších kol najednou, což kontrolu „preserved thinking“ nenarušuje). Prompty agentů a sada nástrojů jsou za běhu neměnné. Pokud by API při úpravě historie vracelo 400, nastavte opt-in `drop_block` (beta `thinking-binding-controls-2026-08-01`) – zatím neověřeno na živém API.
- `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): při odmítnutí bezpečnostním klasifikátorem API samo zopakuje požadavek na jiném modelu; vypnutí `ANTHROPIC_FALLBACKS=false`. Odmítnutí bez záchrany vrátí zákazníkovi předání kolegovi.
- Forced `tool_choice` se nepoužívá (u nových modelů vrací 400).
