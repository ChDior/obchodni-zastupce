-- AI CORE (doménově nezávislé; znovupoužitelné pro CIHLICKY.CZ)

create table ai_policies (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table ai_audit_log (
  id              bigserial primary key,
  ts              timestamptz not null,
  request_id      text,
  actor_type      text not null,
  actor_id        text not null,
  action          text not null,
  tool            text,
  status          text not null,
  entity_type     text,
  entity_id       text,
  input           jsonb,
  output          jsonb,
  error_code      text,
  approval_id     uuid,
  conversation_id uuid,
  duration_ms     integer,
  prev_hash       text not null,
  hash            text not null
);
create index ai_audit_log_ts_idx on ai_audit_log (ts desc);
create index ai_audit_log_tool_idx on ai_audit_log (tool);

create function ai_audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'ai_audit_log is append-only';
end $$;
create trigger ai_audit_log_no_update before update or delete on ai_audit_log
  for each row execute function ai_audit_log_immutable();

create table ai_approvals (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  tool            text,                 -- null = pouhé rozhodnutí člověka bez automatické akce
  category        text not null,        -- discount | price_change | terms | delivery_date | legal | complaint | email | status_change | other
  summary         text not null,
  reason          text,
  input           jsonb,                -- původní vstup nástroje (obsahuje i osobní údaje; přístup jen admin)
  actor_type      text not null,
  actor_id        text not null,
  conversation_id uuid,
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','expired','executed','failed')),
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  result          jsonb,
  error           text,
  expires_at      timestamptz not null
);
create index ai_approvals_status_idx on ai_approvals (status, created_at desc);

create table ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null default 'web',
  customer_id uuid,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now()
);

create table ai_messages (
  id              bigserial primary key,
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index ai_messages_conv_idx on ai_messages (conversation_id, id);

-- výchozí politiky (konzervativní). Mění je jen člověk v administraci.
insert into ai_policies (key, value, description) values
  ('discount.max_auto_pct',        '0',     'Max. sleva (%), kterou AI smí zapsat do nabídky bez schválení'),
  ('quote.approval_threshold_net', '500000','Nabídky nad tuto hodnotu bez DPH vyžadují schválení'),
  ('email.ai_auto_send',           'false', 'Smí AI odesílat e-maily zákazníkům bez schválení'),
  ('email.daily_limit',            '50',    'Max. počet e-mailů vytvořených AI za 24 h'),
  ('approval.expires_hours',       '72',    'Platnost žádosti o schválení'),
  ('agent.max_steps',              '8',     'Max. počet kroků (volání nástrojů) agenta na jeden běh'),
  ('quote.valid_days',             '14',    'Platnost nabídky ve dnech'),
  ('lead.qualify_min_score',       '60',    'Min. skóre pro stav qualified');
