# BELETA AI – gap analýza

Porovnání výchozího stavu (prázdný repozitář) s `MASTER_SPEC.md`. Protože nic neexistovalo, nebyly body kategorie A/B/D; v tabulce je uveden **stav po tomto vývoji** (sloupec „Nyní“), aby bylo zřejmé, co zbývá.

Kategorie: **A** již existuje · **B** existuje částečně · **C** nutno vytvořit · **D** nutno změnit · **E** pozdější fáze.
Výchozí kategorie vždy **C** (nebo **E**). „Nyní“: ✅ hotovo, 🟡 částečně, ⛔ nehotovo.

| Req | Požadavek | Výchozí | Požadovaný stav | Návrh řešení | Riziko | Priorita | Nyní |
|---|---|---|---|---|---|---|---|
| R-01 | Produktové vyhledávání | C | Hledání bez diakritiky, detail, cena, sklad | `products/prices/stock`, tools search/get_product/get_price/check_stock, REST `/api/public/products` | Kvalita dat katalogu (import z ERP) | Vysoká | ✅ import z CSV (`npm run import`) · ⛔ skutečná data a import z ERP |
| R-02 | Znalostní báze | C | Dokumentace se zdroji | `kb_*`, `search_knowledge`, `KnowledgeProvider` | Lexikální vyhledávání < vector store | Vysoká | 🟡 lokální; OpenAI File Search jako adaptér |
| R-03 | Webový AI poradce | C | Chat se zdroji, historií | `/api/public/chat`, `/widget`, SALES MANAGER | Prompt injection, náklady, zneužití | Vysoká | ✅ (nutný `OPENAI_API_KEY`) |
| R-04 | Kalkulace | C | Z pravidel v DB | `calc_rules`, `accessory_rules`, shipping | Chybná pravidla v DB = chybné množství | Vysoká | ✅ |
| R-05 | Lead + kvalifikace | C | Serverové skóre | `create_lead/update_lead`, `scoreLead` | Pravidla skóre jsou odhad – doladit | Střední | ✅ |
| R-06 | CRM projekt | C | Projekt navázaný na zákazníka/lead | `projects`, tools | — | Střední | ✅ |
| R-07 | Nabídka | C | Ceny/sklad/doprava z DB, guardrails | `create_quote/update_quote`, `priceQuote`, guard | Číslování per rok, PDF jako příloha e-mailu | Vysoká | 🟡 PDF hotové (admin), bez přílohy a bez číslování per rok |
| R-08 | E-mail | C | Jen zákazníkům z CRM, se schvalováním | `send_email`, outbox, `EmailTransport` | Reálný transport netestován | Střední | 🟡 SMTP/n8n/log; netestováno živě, bez příloh, bez příjmu odpovědí |
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
| R-23 | Hledání příležitostí | E | Aktivní vyhledávání zakázek s fasádou z obkladových pásků / lícových cihel na internetu | Agent OPPORTUNITY SCOUT + tools `web_search`/`fetch_page`, fronta příležitostí v admin – **návrh v `docs/AI_OPPORTUNITY_SEARCH.md`** | Právní (GDPR, nevyžádaná sdělení), náklady, kvalita zdrojů | **Vysoká (zadavatel potvrdil jako úkol)** | 🟡 implementováno (v1), neověřeno živě |
| R-24 | Hlas/telefon | E | — | Realtime API + stejné tools | — | Nízká | ⛔ |
| R-25 | OpenAI / n8n / PostgreSQL | C | Dle zadání | provider, webhook, SQL | PGlite ≠ produkční PG | Vysoká | 🟡 SMTP, n8n webhook a PG/PGlite hotové; ⛔ `pg` adaptér, ⛔ hotové n8n workflow, ⛔ živé ověření |
| R-26 | Testy | C | 12 scénářů + chyby | 94+ testů | — | Vysoká | ✅ |
| R-27 | Dokumentace | C | 8 dokumentů + audit | `docs/` | — | Střední | ✅ |

**D – nutno změnit:** nic (nebylo co měnit). Budoucí změny nad rámec baseline: PGlite → PostgreSQL server; lokální KB → OpenAI File Search; demo seed → ERP import.


## Doplněno po baseline (stav k poslednímu commitu)
Hotovo navíc: SMTP transport, PDF nabídek, GDPR (export/výmaz/retence), 2FA + správa uživatelů, reset hesla CLI, logování spotřeby tokenů (`/ai-sales/usage`), import CSV (katalog, ceny, sklad, kalkulace, doprava).

## Co stále chybí (podle `MASTER_SPEC.md`; původní zadání v repozitáři není, viz poznámka v MASTER_SPEC)
| # | Oblast | Chybí | Souvisí |
|---|---|---|---|
| 1 | Živé ověření | ANTHROPIC klíč, sada reálných dotazů, ladění promptů (zatím jen simulovaní klienti); OpenAI/Ollama/n8n/SMTP živě netestováno | R-03, R-12, R-25, R-26 |
| 2 | Skutečná data | reálný katalog/ceny/sklad/pravidla/doprava, technická dokumentace do KB; import z ERP | R-01, R-02, R-04 |
| 3 | ~~Databáze~~ ✅ | adaptér `pg` hotový a ověřen na PostgreSQL 16; rate limiter je sdílený přes DB (`DATABASE_URL`) | R-25 |
| 4 | n8n | workflow v `n8n/` (follow-upy, retence) hotové, neověřeno naživo; chybí případný workflow pro inbound e-maily | R-25, R-09 |
| 5 | Znalostní báze | OpenAI File Search / vektorové vyhledávání (lokální KB je lexikální) | R-02, R-25 |
| 6 | ~~Nabídky~~ ✅ | hotovo: číslování po letech, PDF příloha, odeslání jedním krokem z administrace | R-07, R-08 |
| 7 | E-mail | příjem a zpracování odpovědí zákazníků (inbound), šablony | R-08, R-09 |
| 8 | Administrace | ✅ stránka zákazníků + GDPR tlačítka; editace katalogu, cen, skladu a kalkulačních pravidel v UI hotová (příslušenství a doprava jen přes import CSV); správa KB v UI hotová (.md, .txt, .pdf s textovou vrstvou; bez OCR) | R-11 |
| 9 | Widget | ✅ vložení do webu přes profil webu (cihlovestavby.cz / beleta.cz) a `embed.js`; chybí sběr kontaktu před předáním člověku | R-03 |
| 10 | AI core | vytažení do samostatného balíčku pro CIHLICKY.CZ (zatím jen pravidlo bez importu domény) | R-15 |
| 11 | Provoz | Dockerfile a CI přidány (neověřeno); chybí zálohy, monitoring, retence auditu, perzistentní rate limit | nefunkční |
| 12 | **Aktivní vyhledávání zakázek** (fasáda z obkladových pásků / lícových cihel) | ✅ implementováno (v1, `docs/AI_OPPORTUNITY_SEARCH.md`); chybí živé ověření (vyhledávač, klíč, reálné weby), registry zakázek přes API, právní prověření oslovování | R-23 |
| 13 | Pozdější fáze (záměrně) | cold calling, hromadné e-maily, auto slevy, hlas/telefon | R-20, R-21, R-22, R-24 |

## Kontrola proti původnímu zadání (INITIAL DEVELOPMENT TASK)
Zadání bylo dodáno až dodatečně; předchozí `MASTER_SPEC.md` z něj byl jen zpětně sestaven. Skutečné rozdíly:

| Bod zadání | Stav | Poznámka |
|---|---|---|
| Podklady v kořeni (`KNOWLEDGE_BASE.md`, `schema.sql`, `openapi.yaml`, `acceptance.md`, `START_HERE.md`, původní `sales-manager.md` / `technical-agent.md` / `calculation-agent.md`) | ⛔ nebyly k dispozici | Repozitář byl prázdný. Agenti v `agents/*.md` jsou naše vlastní prompty – je třeba je porovnat s dodanými a sloučit. Bez `acceptance.md` neověřeno proti akceptačním kritériím. |
| Fáze 1: audit **existujícího** systému BELETA (framework, DB, admin, kalkulačka, objednávky, SEO, deploy, testy) | ⛔ neprovedeno | Existující BELETA systém v repozitáři není, takže `BELETA_CURRENT_ARCHITECTURE.md` popisuje jen nově vzniklý základ. |
| „Nepřepisuj současný systém“, „použij existující BELETA API“, „UI respektuje současný design administrace“, „integrované BELETA CRM“ | ⛔ nesplněno | Postavili jsme samostatný systém. Integrace na existující web/ERP/CRM/databázi (ceny, produkty, kalkulačka) nebyla možná. |
| Fáze 3: OpenAI API / Agents SDK, OpenAI File Search / vector store | 🟡 | Výchozí je Claude; OpenAI jen přes Chat Completions (ne Agents SDK); File Search chybí. |
| Fáze 3: n8n | 🟡 | Jen rozhraní (webhook, cron endpointy); žádný hotový workflow. |
| Postup „nejdřív návrh A–J ke schválení, až pak programovat“ | 🟡 | Návrh je v `AI_ARCHITECTURE.md`, ale implementace začala bez formálního schválení. |
| Fáze 4–7, 9, 10 (tools, agenti, guardrails, approval, MVP, testy, dokumentace) | ✅ | 18 tools, 6 agentů, 12 povinných testů + další, 10 dokumentů. |
| Fáze 8: administrace (dashboard + 6 sekcí) | ✅ | Ale vlastní design, ne převzatý. |
| Jádro znovupoužitelné pro CIHLICKY.CZ, CIHLOVESTAVBY.CZ, BELETA.CZ | 🟡 | `src/ai-core` je doménově nezávislé, ale není samostatný balíček; třetí/čtvrtá doména (multi-tenant, jiné katalogy/prompty) neřešena. |
| Objednávkový proces, obrázky produktů, SEO | ⛔ | Mimo to, co jsme postavili (viz bod o existujícím systému). |
