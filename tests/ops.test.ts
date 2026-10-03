import { describe, it, expect } from 'vitest';
import { SmtpTransport, emailTransportFromEnv, LogTransport, N8nWebhookTransport } from '../src/beleta/email.js';
import { login, resetPassword } from '../src/beleta/auth.js';
import { makeApp } from './helpers.js';

describe('SMTP transport', () => {
  it('předá zprávu nodemaileru', async () => {
    const sent: any[] = [];
    const t = new SmtpTransport({ host: 'h', port: 587, secure: false, from: 'a@b.cz' }, { sendMail: async o => { sent.push(o); } });
    await t.send({ to: 'x@y.cz', subject: 'S', body: 'B', ref: 'r1' });
    expect(sent[0]).toMatchObject({ from: 'a@b.cz', to: 'x@y.cz', subject: 'S', text: 'B' });
  });
  it('propaguje chybu', async () => {
    const t = new SmtpTransport({ host: 'h', port: 587, secure: false, from: 'a@b.cz' }, { sendMail: async () => { throw new Error('down'); } });
    await expect(t.send({ to: 'x@y.cz', subject: 'S', body: 'B', ref: 'r' })).rejects.toThrow('down');
  });
  it('výběr transportu z prostředí', () => {
    expect(emailTransportFromEnv({})).toBeInstanceOf(LogTransport);
    expect(emailTransportFromEnv({ N8N_EMAIL_WEBHOOK: 'http://n' })).toBeInstanceOf(N8nWebhookTransport);
    expect(emailTransportFromEnv({ SMTP_HOST: 'h', SMTP_FROM: 'a@b.cz' }).name).toBe('smtp');
    expect(() => emailTransportFromEnv({ SMTP_HOST: 'h' })).toThrow();
  });
});

describe('reset hesla', () => {
  it('změní heslo a zneplatní relace', async () => {
    const app = await makeApp();
    const { token } = await login(app.db, 'admin@test.cz', 'test-password-123');
    expect(await resetPassword(app.db, 'admin@test.cz', 'new-password-1234')).toBe(true);
    expect((await app.db.query('select 1 from admin_sessions where token_hash is not null')).length).toBe(0);
    await expect(login(app.db, 'admin@test.cz', 'test-password-123')).rejects.toThrow();
    await login(app.db, 'admin@test.cz', 'new-password-1234');
    expect(token).toBeTruthy();
  });
  it('odmítne krátké heslo a neznámého uživatele', async () => {
    const app = await makeApp();
    await expect(resetPassword(app.db, 'admin@test.cz', 'short')).rejects.toThrow();
    expect(await resetPassword(app.db, 'nikdo@test.cz', 'long-enough-pass1')).toBe(false);
  });
});
