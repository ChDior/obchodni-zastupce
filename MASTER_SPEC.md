# MASTER_SPEC – BELETA AI SALES

> Poznámka k původu: dokumenty `MASTER_SPEC.md`, `KNOWLEDGE_BASE.md`, `schema.sql`, `openapi.yaml` apod. nebyly v repozitáři dodány (repozitář byl prázdný). Tato specifikace je proto sestavena z textu zadání. Obsahuje číslované požadavky (R-xx), na které se odkazuje `docs/BELETA_AI_GAP_ANALYSIS.md`. Přepište/doplňte ji skutečnou obchodní specifikací.

## Cíl
Autonomní AI obchodní zástupce, který obsluhuje zákazníky, doporučuje produkty, pracuje s dokumentací, počítá materiál, připravuje nabídky, kvalifikuje leady, pracuje s CRM, komunikuje e-mailem, provádí follow-up. Později: autonomní vyhledávání příležitostí, hlas/telefon.

## Funkční požadavky (MVP)
- R-01 Produktové vyhledávání (katalog, detail, cena, sklad).
- R-02 AI znalostní báze (technická dokumentace) se zdroji.
- R-03 Webový AI poradce (chat) s uvedením zdrojů informací.
- R-04 Kalkulace materiálu, příslušenství, dopravy (pravidla v DB).
- R-05 Vytvoření a kvalifikace leadu (serverové skóre).
- R-06 CRM projekt.
- R-07 Vytvoření a úprava nabídky (ceny/sklad/doprava z DB).
- R-08 E-mail zákazníkovi.
- R-09 Follow-up (plánování a zpracování splatných).
- R-10 Audit log každé významné AI akce.
- R-11 Administrace AI SALES (dashboard, leady, projekty, nabídky, follow-upy, schvalování, aktivita).

## Architektura / agenti
- R-12 Agenti: SALES MANAGER, PRODUCT, TECHNICAL, CALCULATION, LEAD, COMMUNICATION. Manager nemanipuluje s DB přímo.
- R-13 Tools: get_product, search_products, get_price, check_stock, calculate_material, calculate_accessories, calculate_shipping, create_customer, create_lead, update_lead, create_project, update_project, create_quote, update_quote, send_email, create_followup, request_human_approval – každý s validací, autorizací, error handlingem, audit logem.
- R-14 AI oddělena od obchodních dat; AI nesmí být zdrojem cen, skladu, termínů, parametrů, pravidel.
- R-15 Modulární AI CORE znovupoužitelné pro CIHLICKY.CZ.

## Bezpečnost
- R-16 Guardrails: bez schválení nelze měnit ceny, dávat nestandardní slevy, měnit podmínky, potvrzovat nestandardní termíny, řešit právní spory, rozhodovat vysoké reklamace.
- R-17 Mechanismus HUMAN APPROVAL.
- R-18 Citlivé údaje nejsou v logu.
- R-19 Každá významná akce auditovatelná.

## Mimo rozsah MVP (pozdější fáze)
- R-20 Autonomní cold calling / telefonování.
- R-21 Hromadné autonomní e-maily.
- R-22 Automatické individuální slevy.
- R-23 Autonomní vyhledávání obchodních příležitostí.
- R-24 Hlas/telefon.

## Nefunkční
- R-25 Integrace n8n (automatizace), OpenAI (LLM, znalostní báze), PostgreSQL.
- R-26 Testy (12 povinných scénářů + chybové stavy).
- R-27 Dokumentace (AI_*.md).
