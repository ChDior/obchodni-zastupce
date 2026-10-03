import nodemailer from 'nodemailer';
import type { Db } from '../ai-core/index.js';

export interface EmailAttachment { filename: string; content: Buffer; contentType: string }
export interface EmailMessage { to: string; subject: string; body: string; ref: string; attachments?: EmailAttachment[] }
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
      body: JSON.stringify({ ...m, attachments: m.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content_base64: a.content.toString('base64') })) }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`n8n webhook HTTP ${res.status}`);
  }
}

export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }

/** Přímé odeslání přes SMTP (prostý text). Chyby se propagují – tool označí e-mail jako failed. */
export class SmtpTransport implements EmailTransport {
  name = 'smtp';
  private tx: { sendMail(o: any): Promise<unknown> };
  constructor(private cfg: SmtpConfig, tx?: { sendMail(o: any): Promise<unknown> }) {
    this.tx = tx ?? nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }
  async send(m: EmailMessage): Promise<void> {
    await this.tx.sendMail({ from: this.cfg.from, to: m.to, subject: m.subject, text: m.body, attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })), headers: { 'X-Beleta-Ref': m.ref } });
  }
}

/** Výběr transportu z prostředí: SMTP > n8n webhook > log. */
export function emailTransportFromEnv(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  if (env.SMTP_HOST) {
    if (!env.SMTP_FROM) throw new Error('SMTP_FROM je povinné, pokud je nastaveno SMTP_HOST');
    const port = Number(env.SMTP_PORT || 587);
    return new SmtpTransport({ host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
      user: env.SMTP_USER || undefined, pass: env.SMTP_PASS, from: env.SMTP_FROM });
  }
  if (env.N8N_EMAIL_WEBHOOK) return new N8nWebhookTransport(env.N8N_EMAIL_WEBHOOK);
  return new LogTransport();
}

export async function dailyAiEmailCount(db: Db): Promise<number> {
  const r = await db.query<any>(`select count(*)::int as n from email_outbox where created_by like 'ai:%' and created_at > now() - interval '24 hours'`);
  return r[0].n;
}
