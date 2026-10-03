import { DomainError, type AuditLog, type Db } from '../ai-core/index.js';

const ERASED = '[smazáno]';

/** Anonymizace zákazníka (právo na výmaz). Řádek zákazníka zůstává kvůli vazbám a účetní integritě, osobní údaje mizí. */
export async function eraseCustomer(db: Db, audit: AuditLog, customerId: string, by: string, reason: 'request' | 'retention' = 'request') {
  await db.tx(async (t) => {
    const c = await t.query<any>('select id, erased_at from customers where id=$1 for update', [customerId]);
    if (!c.length) throw new DomainError('customer_not_found', 'Zákazník neexistuje');
    if (c[0].erased_at) throw new DomainError('already_erased', 'Zákazník už byl anonymizován');
    await t.query(
      `update customers set name=$2, company_name=null, ico=null, email=null, phone=null, street=null, city=null, postal_code=null,
         consent_marketing=false, note=null, erased_at=now() where id=$1`, [customerId, ERASED]);
    await t.query(`update leads set summary='', qualification='{}'::jsonb where customer_id=$1`, [customerId]);
    await t.query(`update projects set notes='', name=$2 where customer_id=$1`, [customerId, ERASED]);
    await t.query(`update quotes set notes='', custom_terms=null where customer_id=$1`, [customerId]);
    await t.query(`update followups set note='' where customer_id=$1`, [customerId]);
    await t.query(`update email_outbox set to_email=$2, subject=$2, body=$2 where customer_id=$1`, [customerId, ERASED]);
    // schválení obsahují původní vstup nástrojů (osobní údaje)
    await t.query(`update ai_approvals set input=null where input->>'customer_id'=$1::text or conversation_id in (select id from ai_conversations where customer_id=$1::uuid)`, [customerId]);
    await t.query(`delete from ai_conversations where customer_id=$1`, [customerId]); // ai_messages mizí kaskádou
    await t.query(`insert into gdpr_erasures (customer_id, reason, performed_by) values ($1,$2,$3)`, [customerId, reason, by]);
    await audit.record(t, { actor_type: by.startsWith('human:') ? 'human' : 'system', actor_id: by, action: 'gdpr.erase', status: 'success',
      entity_type: 'customer', entity_id: customerId, output: { reason } });
  });
}

/** Export všech údajů o zákazníkovi (právo na přístup). */
export async function exportCustomer(db: Db, audit: AuditLog, customerId: string, by: string) {
  const c = await db.query<any>('select * from customers where id=$1', [customerId]);
  if (!c.length) throw new DomainError('customer_not_found', 'Zákazník neexistuje');
  const by_customer = (sql: string) => db.query(sql, [customerId]);
  const data = {
    exported_at: new Date().toISOString(),
    customer: c[0],
    leads: await by_customer('select * from leads where customer_id=$1'),
    projects: await by_customer('select * from projects where customer_id=$1'),
    quotes: await db.query(`select q.*, coalesce((select json_agg(i) from quote_items i where i.quote_id=q.id), '[]'::json) as items from quotes q where q.customer_id=$1`, [customerId]),
    followups: await by_customer('select * from followups where customer_id=$1'),
    emails: await by_customer('select id, to_email, subject, body, purpose, status, created_at, sent_at from email_outbox where customer_id=$1'),
    conversations: await db.query(
      `select c.id, c.created_at, coalesce((select json_agg(json_build_object('role', m.role, 'content', m.content, 'at', m.created_at) order by m.id) from ai_messages m where m.conversation_id=c.id), '[]'::json) as messages
       from ai_conversations c where c.customer_id=$1`, [customerId]),
  };
  await audit.record(db, { actor_type: by.startsWith('human:') ? 'human' : 'system', actor_id: by, action: 'gdpr.export', status: 'success', entity_type: 'customer', entity_id: customerId });
  return data;
}

/** Retence: anonymizuje zákazníky bez souhlasu a bez otevřené/přijaté nabídky, kteří jsou neaktivní déle než N měsíců. */
export async function runRetention(db: Db, audit: AuditLog, months: number, by = 'system:retention') {
  if (!months || months <= 0) return { erased: 0, disabled: true };
  const rows = await db.query<{ id: string }>(
    `select c.id from customers c
     where c.erased_at is null and not c.consent_marketing
       and greatest(c.created_at,
             coalesce((select max(updated_at) from leads where customer_id=c.id), c.created_at),
             coalesce((select max(updated_at) from projects where customer_id=c.id), c.created_at),
             coalesce((select max(updated_at) from quotes where customer_id=c.id), c.created_at),
             coalesce((select max(created_at) from email_outbox where customer_id=c.id), c.created_at),
             coalesce((select max(last_active) from ai_conversations where customer_id=c.id), c.created_at)
           ) < now() - ($1 || ' months')::interval
       and not exists (select 1 from quotes q where q.customer_id=c.id and q.status in ('pending_approval','ready','sent','accepted'))
       and not exists (select 1 from followups f where f.customer_id=c.id and f.status in ('pending','draft_created'))`, [String(months)]);
  for (const r of rows) await eraseCustomer(db, audit, r.id, by, 'retention');
  return { erased: rows.length, disabled: false };
}
