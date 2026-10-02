-- BELETA CRM + administrace

create sequence quote_number_seq start 1;

create table customers (
  id           uuid primary key default gen_random_uuid(),
  type         text not null default 'person' check (type in ('person','company')),
  name         text not null,
  company_name text,
  ico          text,
  email        text,
  phone        text,
  street       text,
  city         text,
  postal_code  text,
  consent_marketing boolean not null default false,
  note         text,
  created_by   text not null default 'system',
  created_at   timestamptz not null default now()
);
create unique index customers_email_uq on customers (lower(email)) where email is not null;

create table leads (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id),
  source          text not null default 'web_ai',
  status          text not null default 'new'
                  check (status in ('new','contacted','qualified','nurturing','won','lost')),
  score           integer not null default 0,
  qualification   jsonb not null default '{}',
  summary         text not null default '',
  conversation_id uuid,
  created_by      text not null default 'system',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index leads_status_idx on leads (status, created_at desc);

create table projects (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references customers(id),
  lead_id             uuid references leads(id),
  name                text not null,
  status              text not null default 'draft'
                      check (status in ('draft','calculating','quoted','negotiation','won','lost','on_hold')),
  project_type        text not null default 'other',
  area_m2             numeric(12,2),
  postal_code         text,
  estimated_value_net numeric(14,2) not null default 0,
  notes               text not null default '',
  created_by          text not null default 'system',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table quotes (
  id                     uuid primary key default gen_random_uuid(),
  number                 text not null unique,
  project_id             uuid references projects(id),
  customer_id            uuid not null references customers(id),
  status                 text not null default 'draft'
                         check (status in ('draft','pending_approval','ready','sent','accepted','rejected','expired')),
  currency               text not null default 'CZK',
  discount_pct           numeric(5,2) not null default 0,
  total_net              numeric(14,2) not null default 0,
  total_vat              numeric(14,2) not null default 0,
  total_gross            numeric(14,2) not null default 0,
  shipping_net           numeric(12,2) not null default 0,
  valid_until            date,
  earliest_delivery_date date,
  requested_delivery_date date,
  custom_terms           text,
  notes                  text not null default '',
  created_by             text not null default 'system',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create table quote_items (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references quotes(id) on delete cascade,
  product_id    uuid not null references products(id),
  sku           text not null,
  name          text not null,
  unit          text not null,
  qty           numeric(12,3) not null check (qty > 0),
  unit_price_net numeric(12,2) not null,
  vat_rate      numeric(5,2) not null,
  line_net      numeric(14,2) not null
);

create table followups (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  lead_id     uuid references leads(id),
  project_id  uuid references projects(id),
  quote_id    uuid references quotes(id),
  due_at      timestamptz not null,
  channel     text not null default 'email' check (channel in ('email','phone','task')),
  purpose     text not null,
  status      text not null default 'pending' check (status in ('pending','done','cancelled','draft_created')),
  note        text not null default '',
  created_by  text not null default 'system',
  created_at  timestamptz not null default now()
);
create index followups_due_idx on followups (status, due_at);

create table email_outbox (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  to_email    text not null,
  subject     text not null,
  body        text not null,
  purpose     text not null default 'other',
  quote_id    uuid references quotes(id),
  followup_id uuid references followups(id),
  status      text not null default 'draft' check (status in ('draft','pending_approval','sent','failed','cancelled')),
  transport   text,
  error       text,
  created_by  text not null default 'system',
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create table admin_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null default '',
  role          text not null default 'sales' check (role in ('admin','sales','viewer')),
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table admin_sessions (
  token_hash text primary key,
  user_id    uuid not null references admin_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
