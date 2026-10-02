# BELETA AI – gap analýza

Porovnání výchozího stavu (prázdný repozitář) s `MASTER_SPEC.md`. Protože nic neexistovalo, nebyly body kategorie A/B/D; v tabulce je uveden **stav po tomto vývoji** (sloupec „Nyní“), aby bylo zřejmé, co zbývá.

Kategorie: **A** již existuje · **B** existuje částečně · **C** nutno vytvořit · **D** nutno změnit · **E** pozdější fáze.
Výchozí kategorie vždy **C** (nebo **E**). „Nyní“: ✅ hotovo, 🟡 částečně, ⛔ nehotovo.

| Req | Požadavek | Výchozí | Požadovaný stav | Návrh řešení | Riziko | Priorita | Nyní |
|---|---|---|---|---|---|---|---|
| R-01 | Produktové vyhledávání | C | Hledání bez diakritiky, detail, cena, sklad | `products/prices/stock`, tools search/get_product/get_price/check_stock, REST `/api/public/products` | Kvalita dat katalogu (import z ERP) | Vysoká | ✅ (demo data) · ⛔ import ERP |
| R-02 | Znalostní báze | C | Dokumentace se zdroji | `kb_*`, `search_knowledge`, `KnowledgeProvider` | Lexikální vyhledávání < vector store | Vysoká | 🟡 lokální; OpenAI File Search jako adaptér |
| R-03 | Webový AI poradce | C | Chat se zdroji, historií | `/api/public/chat`, `/widget`, SALES MANAGER | Prompt injection, náklady, zneužití | Vysoká | ✅ (nutný `OPENAI_API_KEY`) |
| R-04 | Kalkulace | C | Z pravidel v DB | `calc_rules`, `accessory_rules`, shipping | Chybná pravidla v DB = chybné množství | Vysoká | ✅ |
| R-05 | Lead + kvalifikace | C | Serverové skóre | `create_lead/update_lead`, `scoreLead` | Pravidla skóre jsou odhad – doladit | Střední | ✅ |
| R-06 | CRM projekt | C | Projekt navázaný na zákazníka/lead | `projects`, tools | — | Střední | ✅ |
| R-07 | Nabídka | C | Ceny/sklad/doprava z DB, guardrails | `create_quote/update_quote`, `priceQuote`, guard | Chybí PDF, číslování per rok | Vysoká | 🟡 bez PDF |
| R-08 | E-mail | C | Jen zákazníkům z CRM, se schvalováním | `send_email`, outbox, `EmailTransport` | Reálný transport netestován | Střední | 🟡 log/n8n |
| R-09 | Follow-up | C | Plánování + zpracování splatných | `create_followup`, `runDueFollowups`, n8n cron | Spam zákazníkům – limity | Střední | ✅ |
| R-10 | Audit | C | Append-only, bez PII | `ai_audit_log`, hash řetěz, `redact` | Retence/objem logu | Vysoká | ✅ |
| R-11 | Administrace | C | Dashboard + 6 sekcí | `/ai-sales/*` | Design nenavazuje (neexistoval) | Střední | ✅ |
| R-12 | Agenti | C | 6 agentů, manager bez DB | `src/beleta/agents.ts`, `agents/*.md` | Kvalita promptů, halucinace | Vysoká | ✅ |
| R-13 | Tools (17+) | C | Validace, scope, chyby, audit | `tools.ts`, `ToolExecutor` | — | Vysoká | ✅ (+`search_knowledge`) |
| R-14 | Oddělení dat od AI | C | Žádná obchodní data v promptech | Testy `prompty neobsahují ceny`, strict schema | Únik přes volný text | Vysoká | ✅ |
| R-15 | Znovupoužitelný AI core | C | CIHLICKY.CZ bez kopírování | `src/ai-core` bez importu domény (test) | Core je zatím v jednom repu (ne balíček) | Střední | 🟡 vytáhnout do npm workspace při druhém nasazení |
| R-16 | Guardrails | C | Dle zadání | `guard` v tools + `ai_policies` | Pokrytí nových nástrojů | Vysoká | ✅ |
| R-17 | Human approval | C | Fronta, rozhodnutí, provedení, expirace | `ai_approvals`, `ApprovalService`, admin UI | — | Vysoká | ✅ |
| R-18 | Bez PII v logu | C | Redakce | `redact()` + testy | Volný text s PII v jiných polích | Vysoká | ✅ |
| R-19 | Auditovatelnost | C | Každá akce, approval_id, conversation_id | viz R-10 | — | Vysoká | ✅ |
| R-20 | Cold calling | E | — | Až po právní analýze (GDPR, zákon o el. komunikacích) | Právní | Nízká | ⛔ záměrně |
| R-21 | Hromadné e-maily | E | — | Denní limit + schvalování jsou připraveny jako brzda | Právní/reputační | Nízká | ⛔ záměrně |
| R-22 | Auto slevy | E | — | `discount.max_auto_pct`=0; rozšířit až s matricí slev | Marže | Nízká | ⛔ záměrně |
| R-23 | Hledání příležitostí | E | — | Nový agent + zdroje dat | — | Nízká | ⛔ |
| R-24 | Hlas/telefon | E | — | Realtime API + stejné tools | — | Nízká | ⛔ |
| R-25 | OpenAI / n8n / PostgreSQL | C | Dle zadání | provider, webhook, SQL | PGlite ≠ produkční PG | Vysoká | 🟡 |
| R-26 | Testy | C | 12 scénářů + chyby | 94+ testů | — | Vysoká | ✅ |
| R-27 | Dokumentace | C | 8 dokumentů + audit | `docs/` | — | Střední | ✅ |

**D – nutno změnit:** nic (nebylo co měnit). Budoucí změny nad rámec baseline: PGlite → PostgreSQL server; lokální KB → OpenAI File Search; demo seed → ERP import.
