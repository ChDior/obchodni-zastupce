# Testy

`npm test` (Vitest, každá sada si staví čerstvou in-memory DB; žádný přístup na síť, LLM nahrazen `ScriptedProvider`). `npm run typecheck`.

| Soubor | Pokrývá |
|---|---|
| `tests/tools.test.ts` | 1 vyhledání produktu (diakritika, injection) · 2 cena (změna v DB se projeví, chybějící cena) · 3 sklad (rezervace, neznámý stav) · 4 kalkulace 100 m² · 5 kalkulace 250 m² · příslušenství · doprava · scopes · KB |
| `tests/crm.test.ts` | 6 lead (dedupe, skóre, qualified) · 7 projekt (hodnota z nabídek) · 8 nabídka (ceny z DB, DPH, strict schema, atomicita) · 9 follow-up (limity, zpracování splatných agentem) |
| `tests/guardrails.test.ts` | 10 human approval (schválit/zamítnout/expirace/failed/jednou) · 11 odmítnutí neoprávněné slevy · termín, podmínky, hodnota, stavy nabídky · e-mail (příjemce z CRM, limity, selhání transportu) |
| `tests/audit.test.ts` | 12 audit (aktér, stav, entity, bez PII, redakce) · append-only · detekce zásahu do hash řetězu · fail-closed |
| `tests/agents.test.ts` | manager bez datových nástrojů · whitelisty · prompty bez cen · ai-core bez závislosti na doméně · delegace, zdroje, prompt injection, max kroků, chat, kompletní nákupní scénář, OpenAI provider (mock fetch) |
| `tests/llm-anthropic.test.ts` | Claude provider (převod zpráv, thinking bloky zpět beze změny, tool_result, refusal, chyba bez těla, fallbacks), agent runtime přes Claude, výběr poskytovatele z env |
| `tests/server.test.ts` | veřejné API · login/CSRF/role/rate limit · cookie flagy · hlavičky · admin workflow včetně schválení · interní token |
| `tests/ops.test.ts`, `tests/gdpr-pdf.test.ts`, `tests/auth2fa.test.ts`, `tests/usage.test.ts`, `tests/import.test.ts` | SMTP transport a reset hesla · PDF nabídky · GDPR export/výmaz/retence · TOTP/záložní kódy/správa uživatelů · účtování tokenů · import CSV (vše-nebo-nic, idempotence, napojení na tools) |
| `tests/postgres.test.ts` | adaptér `pg` (transakce, typy), souběžný audit, unikátní čísla nabídek, souběžné schválení – jen s `TEST_DATABASE_URL`; s touto proměnnou běží proti PostgreSQL i celá sada přes `makeApp` |

Chybové stavy: neexistující entity, neplatné vstupy, nulové/záporné/obří hodnoty, chybějící data (cena, sklad, pravidla), cizí vazby, výpadek LLM/transportu, expirace, dvojí rozhodnutí.

## Co testy NEdokazují (manuální/budoucí)
- Chování skutečného LLM (kvalita dialogu, dodržování promptů) – nutná evaluační sada na živém modelu; bezpečnost však nespoléhá na model, ale na guardy (testovány).
- Živý Claude/OpenAI/n8n/SMTP, PostgreSQL server, zátěž, penetrační test.
- UI bylo ověřeno ručně přes headless Chromium (přihlášení, dashboard, schválení); nejsou automatizované UI testy.

## Jak psát nové testy
Nový tool: úspěch, validace, scope, guard (allow/deny/approval), audit, chyba doménová. Použijte `tests/helpers.ts` (`makeApp`, `run`, `ok`, `newCustomer`).
