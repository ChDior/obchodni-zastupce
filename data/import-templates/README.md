# Šablony pro import CSV

Hlavička + jeden příklad (`PRIKLAD-*`, ceny doplňte vlastní). Excel: uložit jako „CSV UTF-8“ (oddělovač `;` nebo `,` se pozná sám, desetinná čárka je povolena).
Pořadí: `products` → `calc_rules` → `accessory_rules` → `shipping_zones` → `shipping_rates`.

    npm run import -- products data/import-templates/products.csv --dry-run   # zkušební běh, nic nezapíše
    npm run import -- products moje-produkty.csv
    npm run import -- deactivate-demo                                          # vypne ukázkové DEMO-* produkty

Import je „všechno nebo nic“: při jediné chybě se nezapíše nic a vypíšou se čísla řádků. Opakovaný import je bezpečný (aktualizuje podle `sku`, beze změny nic nedělá).
Nový produkt musí mít `price_net` (bez ceny by ho AI nesměla nabízet). `shipping_rates` nahradí všechny sazby zón uvedených v souboru. Extra sloupce `attr_*` jdou do technických parametrů produktu.
Totéž umí REST: `POST /api/admin/ai-sales/import/<typ>?dry_run=1` s tělem `text/csv` (admin).
