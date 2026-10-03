# Aktivní vyhledávání zakázek (R-23) – návrh

**Stav: implementováno (v1), neověřeno na živém vyhledávači a živých webech.** Cíl: AI autonomně hledá na internetu zakázky a stavby, kde se plánuje **fasáda z obkladových pásků nebo lícových cihel** (cihelné pásky, lícové zdivo, cihlový obklad), a předává je obchodníkům jako příležitosti ke zpracování. Autonomní ≠ bez kontroly: AI hledá a vyhodnocuje, **kontaktuje zákazníky až člověk**.

## Co hledá
- Veřejné zakázky (profily zadavatelů, Věstník veřejných zakázek, NEN a podobné) – rekonstrukce a novostavby s lícovou/cihlovou fasádou.
- Developerské projekty a novostavby, oznámení stavebních úřadů a úřední desky (stavební záměr, ohlášení).
- Portfolia architektů a stavebních firem, zprávy o připravovaných stavbách.
- Klíčová slova (konfigurovatelná v DB): obkladové pásky, cihelné pásky, lícové cihly, lícové zdivo, cihlový obklad, klinkerové obklady, „brick slips“, fasáda z cihel; plus fáze projektu (příprava, výběrové řízení, realizace).

## Architektura (znovupoužije AI core, nová doména)
- **Agent `OPPORTUNITY SCOUT`** (jen vyhledávání, žádné odesílání e-mailů, žádný zápis do zákaznických dat mimo příležitosti). SALES MANAGER ho nevolá – běží z cronu.
- **Nové tools** (ToolExecutor, scope `scout:*`, audit): `web_search(query)` (poskytovatel vyměnitelný: vyhledávací API nebo web search nástroj LLM), `fetch_page(url)` (zabezpečené stahování: jen http/https, blokace privátních/lokálních IP (SSRF), limit velikosti a času, respektování `robots.txt`, žádné přihlašování, žádné obcházení ochran), `create_opportunity`, `update_opportunity`.
- **Tabulky:** `opportunities` (zdrojové URL, název, stručný úryvek, organizace, lokalita, odhad rozsahu, fáze, skóre vhodnosti, citace dokládající fasádu, stav `new|reviewed|promoted|dismissed`, otisk pro deduplikaci, nalezeno kdy), `scout_queries` (klíčová slova/zdroje, aktivní), `scout_runs` (běh, počet stránek, tokeny/cena, chyby).
- **Pravidlo „AI nevymýšlí“:** každá příležitost musí mít zdrojovou URL a doslovnou citaci, proč splňuje kritérium; pole bez opory ve zdroji zůstanou prázdná. Skóre vhodnosti počítá server deterministicky z extrahovaných faktů (materiál fasády, rozsah, fáze, region), ne model.
- **Limity z `ai_policies`:** max stránek a dotazů na běh, max běhů za den, strop nákladů (využije logování tokenů), seznam povolených/zakázaných domén.
- **Spuštění:** n8n cron → `POST /api/internal/scout/run` (token jako u follow-upů); ruční spuštění v administraci.

## Administrace
Nová stránka **Příležitosti** (`/ai-sales/opportunities`): fronta nálezů se zdrojem a citací, filtry (stav, region, skóre), akce *Převést na lead* (vytvoří zákazníka/lead/projekt přes standardní tools, tj. s auditem), *Zamítnout*, *Označit jako prověřeno*; přehled běhů a nákladů.

## Právní a etická pravidla (nutné před ostrým provozem)
- Zpracovávat se mají především **veřejné zakázky a firemní/institucionální údaje**; osobní údaje fyzických osob (např. soukromý stavebník) se neukládají nad rámec nezbytného a podléhají GDPR retenci (`gdpr.retention_months`).
- **Žádné automatické oslovení.** E-mail obchodní povahy smí odejít jen po schválení člověkem a při splnění zákona o některých službách informační společnosti (§ 7, nevyžádaná obchodní sdělení) a GDPR – doporučeno ověřit s právníkem. Hromadné autonomní rozesílání zůstává mimo rozsah (R-21).
- Respektovat `robots.txt` a podmínky webů; nízká frekvence dotazů; identifikovatelný User-Agent.

## Testy (až při implementaci)
Mockovaný vyhledávač a stahování: nalezení a uložení příležitosti se zdrojem a citací, deduplikace, odmítnutí SSRF (localhost, 169.254.x, privátní rozsahy), respektování `robots.txt`, limity běhu, zamítnutí nálezu bez citace, převod na lead (audit), práva rolí.

## Rozhodnutí potřebná od zadavatele
1. Poskytovatel vyhledávání (a klíč/rozpočet): API vyhledávače, nebo vestavěné webové vyhledávání LLM.
2. Priorita zdrojů (veřejné zakázky / developeři / úřední desky / architekti) a cílové regiony.
3. Měsíční strop nákladů na vyhledávání.
4. Zda smí AI jen navrhnout kontakt, nebo i připravit (ke schválení) úvodní e-mail.

## Implementace (v1) a odchylky od návrhu
- **Vyhledávač:** vyměnitelné rozhraní; implementovány **Brave Search API** (cenu a bezplatný limit ověřte v aktuálním ceníku poskytovatele) a **SearXNG** (vlastní instance, bez poplatku za dotazy). Cena dotazu se zadává v politice `scout.search_cost_usd_per_query`.
- **Stahování a hledání dělá server, ne model** (levnější a bezpečnější): model dostane jen text jediné stránky a smí jen zavolat `create_opportunity`. Stránka bez klíčových slov (`scout.facade_keywords`, shoda i v různých pádech) se k modelu vůbec nedostane.
- **Náklady:** tři měsíční stropy v administraci (`scout.monthly_budget_usd`, `scout.monthly_token_budget`, `scout.monthly_query_budget`) + limity na běh (`scout.max_queries_per_run`, `scout.max_pages_per_run`); čerpání viz stránka Příležitosti.
- **Návrh e-mailu** vzniká společně s kontaktem (jen když je e-mail na stránce); odeslání provádí člověk v administraci.
- **Region:** celá ČR (dotazy v češtině, `country=CZ` u Brave).
- **Chybí:** zdroje se strukturovaným API (např. registry veřejných zakázek přímo), OCR skenů, filtr podle kraje v seznamu, automatická kontrola právní způsobilosti oslovení, učení se z výsledků (které nálezy skončily obchodem).
