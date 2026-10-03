# BELETA AI SALES

Autonomní AI obchodní zástupce BELETA Plus s.r.o. – **autonomní ≠ bez kontroly**: AI smí jen to, co jí dovolí deterministická pravidla; ostatní jde ke schválení člověku; vše je v auditu.

## Rychlý start
```bash
npm install --legacy-peer-deps
cp .env.example .env        # nastavte ADMIN_*, ANTHROPIC_API_KEY (nebo OPENAI_API_KEY), INTERNAL_TOKEN
npm test                    # 100+ testů
npm run dev                 # http://localhost:3000/ai-sales  (admin),  /widget  (web poradce)
```
LLM: **Claude (Anthropic)** nebo OpenAI – přepínač `LLM_PROVIDER`. Bez klíče běží admin i REST API (katalog, kalkulace), chat vrací 503.
Při `NODE_ENV!=production` se nahrají **ukázková** data (SKU `DEMO-*`). Produkční ceny/sklad se musí importovat z ERP – viz `docs/AI_DEPLOYMENT.md`.

## Windows – jedním dvojklikem
Po stažení projektu (ZIP nebo `git clone`) **ZIP nejdřív rozbalte** (pravé tlačítko → *Extrahovat vše…*; spuštění přímo z ZIPu nefunguje) a ve vytvořené složce **dvakrát klikněte na `start-windows.cmd`**. Skript zkontroluje/nainstaluje Node.js, vytvoří `.env` (zeptá se na váš e-mail a klíč Anthropic, heslo vygeneruje), nainstaluje závislosti, spustí aplikaci a otevře prohlížeč na `http://localhost:3000/ai-sales`. Skript nebyl ověřen na skutečném Windows.

## Dokumentace
`docs/BELETA_CURRENT_ARCHITECTURE.md` · `docs/BELETA_AI_GAP_ANALYSIS.md` · `docs/AI_ARCHITECTURE.md` (návrh, změny DB/API, rizika, plán) · `AI_TOOLS` · `AI_AGENTS` · `AI_SECURITY` · `AI_DATABASE` · `AI_API` · `AI_DEPLOYMENT` · `AI_TESTING`
Pravidla pro vývoj: `CLAUDE.md`, specifikace: `MASTER_SPEC.md`.
