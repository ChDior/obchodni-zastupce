# n8n workflow (importovat: Workflows → Import from File)
- `followups-cron.json` – každých 15 min volá `POST /api/internal/followups/run-due`.
- `gdpr-retention-cron.json` – denně ve 3:00 volá `POST /api/internal/gdpr/retention`.

V n8n nastavte proměnné prostředí `BELETA_AI_URL` (např. `https://ai.example.cz`) a `BELETA_INTERNAL_TOKEN` (= `INTERNAL_TOKEN` aplikace).
E-maily už n8n nepotřebuje (přímý SMTP přes `SMTP_*`); `N8N_EMAIL_WEBHOOK` zůstává jako alternativa (tělo `{to, subject, body, ref, attachments?[{filename, contentType, content_base64}]}`).
**Workflow nebyly spuštěny proti živému n8n.**
