# AI tools

Každý tool: zod schema `.strict()` (neznámá pole = chyba), `scope`, `risk`, volitelný `guard`, `handler`. Výsledek: `{status:'ok',data,sources}` | `{status:'error',error:{code,message}}` | `{status:'pending_approval',approval_id}`. Každé volání se auditně zapíše (úspěch i chyba i zamítnutí).

Chybové kódy společné: `unknown_tool`, `validation_error`, `forbidden` (scope), `denied`-kódy z guardů, `internal_error` (detail se nelogí uživateli).

| Tool | Scope | Vstup (zkráceně) | Výstup | Guard / pravidla |
|---|---|---|---|---|
| `search_products` | catalog:read | query?, category?, limit≤25 | seznam (id, sku, name, unit, popis) | – |
| `get_product` | catalog:read | product (UUID/SKU) | detail + `attributes` | `product_not_found` |
| `get_price` | catalog:read | product, price_list | net, vat, gross, měna, platnost | `price_not_found` (nikdy odhad) |
| `check_stock` | catalog:read | product, qty | free, in_stock, shortfall, nejbližší expedice | `stock_unknown`; termín není slib |
| `calculate_material` | calc:run | product, area_m2 (0–100 000) | požadavek, ztráta, balení, order_qty, váha, cena | `no_calc_rule` |
| `calculate_accessories` | calc:run | product, area_m2? / quantity? | položky příslušenství | `missing_input` |
| `calculate_shipping` | calc:run | items[], postal_code | zóna, váha, vozidla, cena (orientační) | `shipping_unavailable` |
| `create_customer` | crm:write | name, e-mail/telefon, … | customer_id, created | dedupe dle e-mailu; limit/hod pro AI (`rate_limited`) |
| `create_lead` | crm:write | customer_id, summary, qualification | lead_id, score | skóre počítá server; nelze zadat status/score |
| `update_lead` | crm:write | lead_id, status?, qualification? | status, score | `qualified` vyžaduje skóre ≥ politika; `won/lost` → schválení |
| `create_project` | crm:write | customer_id, lead_id?, name, … | project_id | `mismatch` (cizí lead) |
| `update_project` | crm:write | project_id, … | status | `won/lost` → schválení |
| `create_quote` | quote:write | customer_id, items[], shipping_postal_code?, discount_pct?, … | číslo, součty, termín, varování skladu | **schválení**: sleva > limit, vlastní podmínky, dřívější termín, hodnota > práh |
| `update_quote` | quote:write | quote_id, … | totéž | AI nesmí `sent/accepted/rejected` (`status_not_allowed`), odeslanou nabídku nelze měnit (`quote_locked`), jinak jako create |
| `create_opportunity` | scout:write (jen OPPORTUNITY_SCOUT) | url, title, facade_material, evidence (doslovná citace), stage, organization?, location?, region?, scale_note?, contact_*?, draft_subject?/draft_body? | opportunity_id, fit_score, duplicate | stránka musí být v tomto běhu stažena (`not_fetched`); citace i kontakty musí být doslovně ve stránce (`evidence_not_found`, `contact_not_in_source`); návrh e-mailu jen s nalezeným e-mailem a bez cen/čísel s měnou (`draft_without_contact`, `draft_has_prices`); skóre počítá server; duplicitní URL se neukládá |
| `send_email` | email:send | customer_id, subject, body, purpose, quote_id?, followup_id?, attach_quote_pdf? (jen s `quote_id` zákazníka, jinak `no_quote`/`quote_mismatch`) | email_id, status | příjemce jen z CRM; `no_recipient`; `daily_limit`; AI → schválení dle `email.ai_auto_send` |
| `create_followup` | followup:write | customer_id, due_in_days/due_at, channel, purpose | followup_id | `past_due`, `too_far`, `too_many_followups` |
| `request_human_approval` | approval:request | category, summary, reason | approval_id | – |
| `search_knowledge` | kb:read | query, limit | pasáže + zdroj | – |

Přidání nového toolu: definice v `src/beleta/tools.ts`, zařazení do whitelistu agenta v `src/beleta/agents.ts`, testy (úspěch, validace, scope, guard, audit), tento dokument.
