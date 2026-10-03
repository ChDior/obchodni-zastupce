# API

Chyby: `{"error":{"code","message"}}` (HTTP 400 validace, 401 nepřihlášen, 403 zákaz/CSRF, 404, 409 stav, 429 limit, 503 AI nedostupná). Akce čekající na schválení: HTTP 202 `{"pending_approval":{…}}`. Odpovědi z nástrojů nesou `sources[]` (odkud informace pochází).

## Veřejné (bez přihlášení, rate limit 120/min/IP; chat 12/min)
| Metoda | Cesta | Popis |
|---|---|---|
| GET | `/healthz` | `{status, ai}` |
| GET | `/api/public/products?q=&category=&limit=` | Vyhledání (tool `search_products`) |
| GET | `/api/public/products/:ref` | Detail + cena + dostupnost (`ref` = UUID/SKU) |
| POST | `/api/public/calculate` `{product, area_m2}` | Materiál + příslušenství |
| POST | `/api/public/chat` `{message≤2000, conversation_id?}` | Webový AI poradce → `{conversation_id, reply, sources[], awaiting_approval}` |
| GET | `/widget` | Chat UI |

Veřejné API **nemá žádný zápisový endpoint**; zápisy dělá jen AI přes tools a admin.

## Administrace (cookie `beleta_session`; zápisy vyžadují hlavičku `X-Requested-With: beleta-admin`)
| Metoda | Cesta | Role |
|---|---|---|
| POST | `/api/admin/login` `{email,password,code?}` (při zapnutém 2FA bez `code` → 401 `totp_required`; `code` = TOTP nebo jednorázový záložní kód) · `/logout` · GET `/me` | – |
| GET | `/api/admin/ai-sales/dashboard` | všechny |
| GET | `…/leads`, `/projects`, `/quotes`, `/quotes/:id`, `/followups`, `/emails`, `/approvals?status=`, `/activity?tool=&status=&actor=&limit=&offset=`, `/audit/verify`, `/policies` | všechny |
| PATCH | `…/leads/:id` `{status,…}` · `…/quotes/:id` `{status,…}` (tool `update_lead`/`update_quote` jako člověk; zákazy AI pro člověka neplatí) | admin, sales |
| POST | `…/approvals/:id/approve|reject` `{note?}` | admin, sales |
| POST | `…/followups/:id/done|cancel` | admin, sales |
| GET | `…/quotes/:id/pdf` – PDF nabídky (`application/pdf`; nefinální stavy mají značku NÁVRH; hlavička a patička z politik `quote.pdf_seller`, `quote.pdf_footer`) | všechny |
| GET | `…/customers?q=` · `…/customers/:id` – seznam a detail zákazníka (leady, projekty, nabídky, follow-upy, e-maily) | všechny |
| POST | `…/quotes/:id/send` `{subject?,body?}` – odešle nabídku (stav ready/sent) e-mailem s PDF přílohou přes tool `send_email`, po úspěchu nastaví stav `sent` (409 `quote_not_ready`) | admin, sales |
| GET | `…/customers/:id/export` – JSON všech údajů o zákazníkovi (GDPR přístup, auditováno) | admin |
| POST | `…/customers/:id/erase` – anonymizace zákazníka (GDPR výmaz; 409 `already_erased`, auditováno) | admin |
| POST | `/api/admin/2fa/setup` → `{secret, otpauth_uri}` · `/2fa/enable` `{code}` → `{recovery_codes}` (zobrazí se jen jednou) · `/2fa/disable` `{password, code}` | přihlášený (sám sobě) |
| GET/POST/PATCH | `…/users`, `…/users/:id` `{role?,active?,password?,reset_2fa?,name?}` – nelze zablokovat/degradovat sebe ani posledního aktivního admina; změna hesla/role, deaktivace a reset 2FA ukončí relace uživatele | admin |
| GET | `…/usage?days=30` – skutečná spotřeba tokenů LLM (celkem, po dnech, po agentech; `cost_usd` jen při nastavených `LLM_PRICE_*`) | všechny |
| GET | `…/products?q=` · `…/products/:id` – katalog (cena, sklad, kalkulační pravidlo, příslušenství, historie cen) | všechny |
| POST/PATCH | `…/products` · `…/products/:id` – vytvoření/úprava produktu, ceny (nová platná cena od dneška, historie se zachová), skladu, parametrů a kalkulačního pravidla; nový produkt vyžaduje `sku`, `name`, `price_net`; SKU nelze měnit; auditováno (`catalog.create/update`) | admin |
| GET/POST/PUT/DELETE | `…/kb`, `…/kb/:id` (`{title, content, category?, active?}`, POST `…/kb/:id/active` `{active}`) – správa znalostní báze; úseky se přegenerují při uložení; zápisy jen admin, auditováno (`kb.*`); text max. 500 000 znaků | čtení všichni, zápis admin |
| POST | `…/kb/extract` (tělo `application/pdf`, max 10 MB) → `{text, pages}` – jen náhled textu z PDF s textovou vrstvou (sken bez textu = 422 `no_text`, OCR není); uložení přes POST `…/kb` po kontrole | admin |
| GET | `…/opportunities?status=&min_score=` · `…/opportunities/:id` – příležitosti (nález, doslovná citace, kontakt, návrh e-mailu) | všechny |
| PATCH | `…/opportunities/:id` `{status: new|reviewed|dismissed}` | admin, sales |
| POST | `…/opportunities/:id/promote` `{send_email?, subject?, body?}` – vytvoří zákazníka (firma, bez souhlasu) a lead (`source=outbound`) přes tools jako člověk; s `send_email` odešle upravený návrh (+ patička `scout.email_footer`); 422 `no_contact`, 409 `not_pending` | admin, sales |
| GET | `…/scout` – rozpočet (měsíční čerpání vs. stropy), dotazy, posledních 20 běhů | všechny |
| POST | `…/scout/run` – ruční spuštění vyhledávání | admin |
| POST/PATCH/DELETE | `…/scout/queries`, `…/scout/queries/:id` `{query}` / `{active}` | admin |
| GET/POST | `…/import` (popis sloupců) · `…/import/:type?dry_run=1` (`products|calc_rules|accessory_rules|shipping_zones|shipping_rates`, tělo `text/csv`, max 5 MB, vše-nebo-nic) · `…/demo/deactivate` | admin |
| PUT | `…/policies/:key` `{value}` (typ musí odpovídat) | admin |

## Stránky
`/ai-sales`, `/ai-sales/leads|projects|quotes|followups|approvals|activity|policies` (SPA).

## Interní (n8n)
| POST | `/api/internal/followups/run-due` | hlavička `X-Internal-Token` (= `INTERNAL_TOKEN`) → `{processed}` |
| POST | `/api/internal/scout/run` | stejný token → `{run_id, queries, pages, analysed, found, skipped?, note?}`; respektuje `scout.enabled` a měsíční stropy (n8n cron denně) |
| POST | `/api/internal/gdpr/retention` | stejný token → `{erased, disabled}`; anonymizuje zákazníky bez souhlasu a bez otevřené/přijaté nabídky a otevřených follow-upů, neaktivní déle než politika `gdpr.retention_months` (0 = vypnuto). Doporučeno volat z n8n cronem denně. |

## Poznámky ke kompatibilitě
Nové API; žádná zpětná kompatibilita nebyla třeba. Další změny: přidávat pole/endpointy, neměnit významy existujících, a zapsat sem.
