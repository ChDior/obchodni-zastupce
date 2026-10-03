-- Aktivní vyhledávání zakázek (OPPORTUNITY SCOUT)

create table scout_queries (
  id          uuid primary key default gen_random_uuid(),
  query       text not null unique,
  active      boolean not null default true,
  last_run_at timestamptz,
  created_at  timestamptz not null default now()
);

create table scout_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','done','error','skipped')),
  trigger     text not null default 'cron',
  queries     integer not null default 0,
  pages       integer not null default 0,
  analysed    integer not null default 0,
  found       integer not null default 0,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  note        text
);

-- stránky, které už byly vyhodnoceny (nestahovat znovu)
create table scout_seen (
  url_key text primary key,
  seen_at timestamptz not null default now(),
  outcome text not null
);

create table opportunities (
  id             uuid primary key default gen_random_uuid(),
  url            text not null,
  url_key        text not null unique,
  title          text not null,
  organization   text,
  location       text,
  region         text,
  stage          text not null default 'unknown' check (stage in ('tender','planning','construction','completed','unknown')),
  facade_material text not null default 'other' check (facade_material in ('brick_slips','facing_brick','other')),
  scale_note     text,
  evidence       text not null,
  fit_score      integer not null default 0,
  contact_email  text,
  contact_phone  text,
  contact_name   text,
  draft_subject  text,
  draft_body     text,
  status         text not null default 'new' check (status in ('new','reviewed','promoted','dismissed')),
  lead_id        uuid references leads(id),
  run_id         uuid references scout_runs(id),
  found_at       timestamptz not null default now(),
  decided_by     text,
  decided_at     timestamptz
);
create index opportunities_status_idx on opportunities (status, fit_score desc, found_at desc);

insert into scout_queries (query) values
  ('fasáda obkladové pásky veřejná zakázka'),
  ('lícové cihly fasáda novostavba projekt'),
  ('cihelné pásky zateplení fasády rekonstrukce'),
  ('lícové zdivo fasáda výběrové řízení'),
  ('cihlový obklad fasády bytový dům developer');

insert into ai_policies (key, value, description) values
  ('scout.enabled',                'false', 'Zapnout automatické vyhledávání zakázek (cron). Ruční spuštění v administraci funguje vždy'),
  ('scout.max_queries_per_run',    '4',     'Max. počet vyhledávacích dotazů na jeden běh'),
  ('scout.max_pages_per_run',      '12',    'Max. počet stažených a vyhodnocených stránek na jeden běh'),
  ('scout.monthly_budget_usd',     '5',     'Měsíční strop nákladů vyhledávání (USD; platí, jen když jsou nastavené ceny LLM_PRICE_* nebo cena dotazu)'),
  ('scout.monthly_token_budget',   '1000000','Měsíční strop tokenů LLM pro vyhledávání (platí vždy)'),
  ('scout.monthly_query_budget',   '300',   'Měsíční strop počtu vyhledávacích dotazů (platí vždy)'),
  ('scout.search_cost_usd_per_query','0',   'Cena jednoho vyhledávacího dotazu u vašeho poskytovatele (USD) – pro odhad nákladů'),
  ('scout.facade_keywords',        '"obkladové pásky,obkladových pásků,cihelné pásky,cihelných pásků,lícové cihly,lícových cihel,lícové zdivo,lícového zdiva,cihlový obklad,cihlového obkladu,cihelný obklad,klinkerové pásky,brick slips,facing brick"', 'Klíčová slova (čárkou); stránka bez nich se vůbec nevyhodnocuje'),
  ('scout.blocked_domains',        '""',      'Domény, které se nikdy nestahují (čárkou)'),
  ('scout.retention_days',         '180',   'Po kolika dnech se nepřevedené (nové/zamítnuté) příležitosti mažou'),
  ('scout.email_footer',           '"Pokud si další zprávy nepřejete, stačí odpovědět slovem „nechci“."', 'Patička úvodního e-mailu k příležitosti')
on conflict (key) do nothing;
