# Databáze

PostgreSQL dialekt (`gen_random_uuid`, JSONB, plpgsql trigger). Migrace v `db/core` (AI core) a `db/beleta` (doména), aplikují se v pořadí jednou (`schema_migrations`). **Aplikované migrace se neupravují – nová změna = nový soubor.**

## AI core (`db/core/001_ai_core.sql`)
| Tabulka | Účel |
|---|---|
| `ai_policies` | Limity pravomocí AI (klíč/JSONB hodnota, kdo změnil). Výchozí: `discount.max_auto_pct=0`, `quote.approval_threshold_net=500000`, `email.ai_auto_send=false`, `email.daily_limit=50`, `approval.expires_hours=72`, `agent.max_steps=8`, `quote.valid_days=14`, `lead.qualify_min_score=60` |
| `ai_audit_log` | Append-only audit (trigger), hash řetěz (`prev_hash`,`hash`) |
| `ai_approvals` | Fronta schvalování (stav, vstup akce, rozhodnutí, výsledek, expirace) |
| `ai_conversations`, `ai_messages` | Konverzace webového poradce |

## BELETA (`db/beleta/001–003`)
| Skupina | Tabulky |
|---|---|
| Katalog | `products` (`attributes` JSONB, `search_text`), `prices` (ceníky, platnost, DPH), `stock` (volné/rezervované, dodací lhůta) |
| Kalkulace | `calc_rules`, `accessory_rules`, `shipping_zones` (prefix PSČ), `shipping_rates` |
| Znalosti | `kb_documents`, `kb_chunks` |
| CRM | `customers` (unikátní e-mail), `leads` (score, qualification JSONB), `projects`, `quotes` + `quote_items` (snapshot cen), `followups`, `email_outbox` |
| Admin | `admin_users`, `admin_sessions` (hash tokenu) |
| Politiky | `003_policies.sql`: `vat.default_rate`, limity follow-upů a zákazníků |

## Poznámky
- Peníze `numeric(12,2)`; v kódu zaokrouhlení na 2 desetinná místa, součty v jedné funkci (`priceQuote`).
- `projects.estimated_value_net` se odvozuje z nabídek (`recomputeProjectValue`), ne od AI.
- Sloupce `date` vrací driver jako `Date` – používejte `dateStr()`.
- Katalog (`products/prices/stock`) je **zdrojem pravdy pro AI**; plní ho import z ERP, ne AI. Demo seed jen mimo produkci.
- Indexy: základní; při růstu přidat trigramový/FTS index na `products.search_text`.


## Novější migrace
`db/core/003_rate_limits.sql` (sdílený limiter) · `db/beleta/006_quote_numbering.sql` · `db/beleta/007_kb_updated.sql` · `db/beleta/008_scout.sql` (`scout_queries`, `scout_runs`, `scout_seen`, `opportunities`, politiky `scout.*`) · `db/core/002_llm_usage.sql` (`ai_llm_usage` – tokeny a model per volání LLM, bez obsahu) · `db/beleta/004_gdpr_pdf.sql` (`customers.erased_at`, `gdpr_erasures`, politiky `gdpr.retention_months`, `quote.pdf_*`) · `db/beleta/005_2fa_users.sql` (TOTP sloupce v `admin_users`).
