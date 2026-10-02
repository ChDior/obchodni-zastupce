import type { Db } from '../ai-core/index.js';

export interface EmailMessage { to: string; subject: string; body: string; ref: string }
export interface EmailTransport { name: string; send(m: EmailMessage): Promise<void> }

/** Výchozí transport: nic neodesílá, jen zapíše do outboxu (bezpečné pro vývoj/MVP). */
export class LogTransport implements EmailTransport {
  name = 'log';
  async send(): Promise<void> { /* záměrně prázdné – záznam je v email_outbox */ }
}

/** Odeslání přes n8n webhook (n8n řeší SMTP/Gmail/Ecomail apod.). */
export class N8nWebhookTransport implements EmailTransport {
  name = 'n8n';
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {}
  async send(m: EmailMessage): Promise<void> {
    const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`n8n webhook HTTP ${res.status}`);
  }
}

export async function dailyAiEmailCount(db: Db): Promise<number> {
  const r = await db.query<any>(`select count(*)::int as n from email_outbox where created_by like 'ai:%' and created_at > now() - interval '24 hours'`);
  return r[0].n;
}
