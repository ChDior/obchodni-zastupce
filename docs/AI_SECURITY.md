# Bezpečnost a guardrails

## Model oprávnění AI
| Vrstva | Mechanismus |
|---|---|
| Agent whitelist | Agent smí volat jen své nástroje |
| Scope aktéra | `catalog:read`, `calc:run`, `crm:write`, `quote:write`, `email:send`, `followup:write`, `approval:request`, `kb:read`; veřejné REST = jen read/calc/kb |
| Strict schema | Cenu, skóre, příjemce e-mailu ani status „sent“ nelze zadat – pole neexistují |
| Guard | Deterministická pravidla v kódu s limity z `ai_policies` |
| Approval | Akce mimo pravomoc → `ai_approvals`; provede se až po lidském schválení |
| Audit | Append-only, hash řetěz, fail-closed |

## Co AI nesmí bez schválení (implementace)
| Zadání | Implementace |
|---|---|
| měnit ceny | Neexistuje tool ani pole pro změnu ceny; ceny jen čtení. Požadavek zákazníka → `request_human_approval(price_change)` |
| nestandardní slevy | `discount_pct` > `discount.max_auto_pct` (výchozí 0) → schválení; i dodatečně přes `update_quote` |
| měnit podmínky | `custom_terms` → schválení |
| nestandardní termíny | `requested_delivery_date` dřívější než systémový → schválení; AI termín nepotvrzuje |
| právní spory / reklamace | `request_human_approval(legal|complaint)`; instrukce v promptech |
| vysoká hodnota | nabídka > `quote.approval_threshold_net` → schválení |
| uzavření obchodu | `won/lost` leadu/projektu → schválení; `sent/accepted` nabídky jen člověk |
| e-maily | příjemce jen zákazník z CRM; AI e-mail ke schválení (`email.ai_auto_send=false`); denní limit |

## Human approval
`pending → approved → executed|failed`, nebo `rejected`, `expired` (`approval.expires_hours`). Přechod je atomický (`UPDATE … WHERE status='pending'`), rozhodnout lze jednou. Schválit může jen aktér typu `human` s rolí admin/sales. Provedení znovu validuje vstup, běží s původním AI aktérem, `deny` pravidla platí dál; selhání = `failed` (viditelné v UI). Každý krok je v auditu (`approval.created`, `approval.decided`, `tool.call.approved`).

## Audit a citlivé údaje
- `redact()` maskuje e-maily, telefony, adresy, jména, hesla, tokeny (klíče i volný text) – test ověřuje, že PII není v tabulce auditu.
- Tabulka `ai_audit_log`: trigger zakazuje UPDATE/DELETE; `hash = sha256(prev_hash + obsah)`; `GET /api/admin/ai-sales/audit/verify` řetěz ověří (UI ukazuje stav). Pozn.: správce DB s právem vypnout trigger může zápis zfalšovat, ale řetěz to odhalí; pro vyšší záruku exportovat hash do externího úložiště.
- `ai_approvals.input` obsahuje původní vstup (i PII) – nutné pro provedení; přístup jen přihlášení.
- Chyby LLM se uživateli neukazují; tělo odpovědi OpenAI se nelogí.

## Webová bezpečnost
CSP `default-src 'self'` (žádné inline skripty/styly), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS v produkci; admin UI vkládá data jen přes `textContent` (XSS); cookie HttpOnly+SameSite=Strict(+Secure v produkci); CSRF: vlastní hlavička + kontrola `Origin`; hesla scrypt, konstantní čas i pro neexistující účet; rate limit loginu (účet+IP), chatu a veřejného API; limit těla 64 kB; interní endpoint token (timing-safe), v produkci povinný; SQL výhradně parametrizovaně.

## Zbytková rizika / TODO
Chybí perzistentní rate limiting, penetrační test, skenování závislostí v CI.


## GDPR
Výmaz = anonymizace (`src/beleta/gdpr.ts`): řádek zákazníka zůstává (vazby, účetní integrita), osobní údaje, poznámky, e-maily v outboxu, konverzace a vstupy schválení se mažou/nulují. Audit je append-only a PII neobsahuje, hash řetěz zůstává platný; výmaz i export se auditují (`gdpr.erase`, `gdpr.export`) a evidují v `gdpr_erasures`. Retence řízena politikou `gdpr.retention_months`.

## 2FA a uživatelé
TOTP (RFC 6238, bez externích závislostí, tolerance ±1 krok, ochrana proti opakování použitého kódu) + 8 jednorázových záložních kódů (v DB jen SHA-256). Tajný klíč TOTP je v DB v čistém textu (chraňte DB/zálohy). Zapnutí 2FA se vynucuje jen organizačně (není povinné). Ztracené 2FA resetuje admin v `/ai-sales/users`; ztracené heslo/2FA posledního admina: `npm run reset-password` (změní heslo, vypne 2FA).
