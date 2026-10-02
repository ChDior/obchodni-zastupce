import type { Db } from '../ai-core/index.js';

export async function dashboard(db: Db) {
  const one = async (sql: string) => (await db.query<any>(sql))[0];
  const leads = await db.query<any>(`select status, count(*)::int n from leads group by status`);
  const byStatus = Object.fromEntries(leads.map((r) => [r.status, r.n]));
  const projects = await one(`select count(*)::int n, coalesce(sum(estimated_value_net),0)::float8 v from projects where status in ('draft','calculating','quoted','negotiation')`);
  const quotes = await one(`select count(*)::int n, coalesce(sum(total_net),0)::float8 v from quotes where status in ('draft','pending_approval','ready','sent')`);
  const fu = await one(`select count(*) filter (where status='pending')::int pending, count(*) filter (where status='pending' and due_at <= now())::int due from followups`);
  const ap = await one(`select count(*)::int n from ai_approvals where status='pending' and expires_at > now()`);
  return {
    new_leads: byStatus.new ?? 0, qualified_leads: byStatus.qualified ?? 0,
    active_projects: projects.n, open_quotes: quotes.n, open_quotes_value_net: quotes.v,
    followups_pending: fu.pending, followups_due: fu.due, pending_approvals: ap.n,
    potential_value_net: projects.v,
  };
}

const page = (limit?: number, offset?: number) => [Math.min(limit ?? 100, 500), offset ?? 0];

export async function listLeads(db: Db, status?: string, limit?: number, offset?: number) {
  return db.query(
    `select l.id, l.status, l.score, l.source, l.summary, l.qualification, l.created_at, l.updated_at, c.name as customer_name, c.email, c.phone, l.customer_id
     from leads l join customers c on c.id=l.customer_id ${status ? 'where l.status=$3' : ''} order by l.created_at desc limit $1 offset $2`,
    status ? [...page(limit, offset), status] : page(limit, offset));
}
export async function listProjects(db: Db, status?: string, limit?: number, offset?: number) {
  return db.query(
    `select p.id, p.name, p.status, p.project_type, p.area_m2, p.postal_code, p.estimated_value_net::float8 as estimated_value_net, p.notes, p.created_at, p.updated_at, c.name as customer_name, p.customer_id
     from projects p join customers c on c.id=p.customer_id ${status ? 'where p.status=$3' : ''} order by p.created_at desc limit $1 offset $2`,
    status ? [...page(limit, offset), status] : page(limit, offset));
}
export async function listQuotes(db: Db, status?: string, limit?: number, offset?: number) {
  return db.query(
    `select q.id, q.number, q.status, q.currency, q.discount_pct::float8 as discount_pct, q.total_net::float8 as total_net, q.total_gross::float8 as total_gross,
            q.valid_until, q.earliest_delivery_date, q.requested_delivery_date, q.custom_terms, q.created_by, q.created_at, c.name as customer_name, q.customer_id
     from quotes q join customers c on c.id=q.customer_id ${status ? 'where q.status=$3' : ''} order by q.created_at desc limit $1 offset $2`,
    status ? [...page(limit, offset), status] : page(limit, offset));
}
export async function getQuote(db: Db, id: string) {
  const q = await db.query<any>(`select q.*, c.name as customer_name from quotes q join customers c on c.id=q.customer_id where q.id=$1`, [id]);
  if (!q.length) return null;
  const items = await db.query(`select sku, name, unit, qty::float8 as qty, unit_price_net::float8 as unit_price_net, line_net::float8 as line_net from quote_items where quote_id=$1 order by name`, [id]);
  return { ...q[0], items };
}
export async function listFollowups(db: Db, status?: string, limit?: number, offset?: number) {
  return db.query(
    `select f.id, f.status, f.channel, f.purpose, f.note, f.due_at, f.created_by, f.created_at, c.name as customer_name, f.customer_id
     from followups f join customers c on c.id=f.customer_id ${status ? 'where f.status=$3' : ''} order by f.due_at asc limit $1 offset $2`,
    status ? [...page(limit, offset), status] : page(limit, offset));
}
export async function setFollowupStatus(db: Db, id: string, status: 'done' | 'cancelled') {
  return db.query(`update followups set status=$2 where id=$1 and status in ('pending','draft_created') returning id`, [id, status]);
}
export async function listEmails(db: Db, limit?: number) {
  return db.query(`select e.id, e.subject, e.purpose, e.status, e.transport, e.created_by, e.created_at, e.sent_at, c.name as customer_name from email_outbox e join customers c on c.id=e.customer_id order by e.created_at desc limit $1`, [Math.min(limit ?? 100, 500)]);
}
