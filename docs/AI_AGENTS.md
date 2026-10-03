# AI agenti

Agent = `{name, instructions, tools[] (whitelist), delegates}`. Runtime: `runAgent` (`src/ai-core/agent.ts`). Prompty: `agents/*.md` + společná pravidla `agents/_common.md`.

| Agent | Nástroje | Odpovědnost |
|---|---|---|
| SALES_MANAGER | `request_human_approval` + `delegate_*` | Vede dialog, zjišťuje potřebu, deleguje, eskaluje. **Nemá žádný datový nástroj** |
| PRODUCT_AGENT | search_products, get_product, get_price, check_stock | Produkty, ceny, dostupnost |
| TECHNICAL_AGENT | search_knowledge, get_product | Technické odpovědi jen z dokumentace |
| CALCULATION_AGENT | calculate_*, get_price, check_stock | Kalkulace |
| LEAD_AGENT | create_customer, create_lead, update_lead, create_project, update_project, create_quote, update_quote, create_followup, request_human_approval | CRM a nabídky |
| OPPORTUNITY_SCOUT | create_opportunity | Vyhodnotí text stažené stránky a uloží příležitost s citací (spouští ho `runScout`, ne zákaznický chat; SALES_MANAGER ho nevolá) |
| COMMUNICATION_AGENT | send_email, create_followup, get_price, check_stock | E-maily a follow-upy (též z n8n cronu) |

## Pravidla runtime
- Volání nástroje mimo whitelist → `tool_not_allowed` + auditní záznam `denied`.
- Max. kroků na běh: politika `agent.max_steps` (8); po vyčerpání bezpečná odpověď + audit `max_steps`.
- Max. hloubka delegace 2. Každá delegace se auditně zapíše.
- Výsledek `pending_approval` se vrací agentovi pravdivě („nic nebylo provedeno“); chat vrací `awaiting_approval`.
- Zdroje (`sources`) ze všech nástrojů se sbírají a vrací klientovi.
- Aktér: `ai:web-advisor` (chat), `ai:followup-bot` (cron). Scopes viz `src/beleta/actors.ts`.

## Úpravy promptů
Prompty nesmí obsahovat ceny, slevy, termíny ani parametry produktů (hlídá test). Změna chování = změna pravidel v `ai_policies`/guardech, ne prosba v promptu.
