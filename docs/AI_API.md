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
| POST | `/api/admin/login` `{email,password}` · `/logout` · GET `/me` | – |
| GET | `/api/admin/ai-sales/dashboard` | všechny |
| GET | `…/leads`, `/projects`, `/quotes`, `/quotes/:id`, `/followups`, `/emails`, `/approvals?status=`, `/activity?tool=&status=&actor=&limit=&offset=`, `/audit/verify`, `/policies` | všechny |
| PATCH | `…/leads/:id` `{status,…}` · `…/quotes/:id` `{status,…}` (tool `update_lead`/`update_quote` jako člověk; zákazy AI pro člověka neplatí) | admin, sales |
| POST | `…/approvals/:id/approve|reject` `{note?}` | admin, sales |
| POST | `…/followups/:id/done|cancel` | admin, sales |
| PUT | `…/policies/:key` `{value}` (typ musí odpovídat) | admin |

## Stránky
`/ai-sales`, `/ai-sales/leads|projects|quotes|followups|approvals|activity|policies` (SPA).

## Interní (n8n)
| POST | `/api/internal/followups/run-due` | hlavička `X-Internal-Token` (= `INTERNAL_TOKEN`) → `{processed}` |

## Poznámky ke kompatibilitě
Nové API; žádná zpětná kompatibilita nebyla třeba. Další změny: přidávat pole/endpointy, neměnit významy existujících, a zapsat sem.
