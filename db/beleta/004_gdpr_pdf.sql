-- GDPR (výmaz/retence) + nastavení PDF nabídek
alter table customers add column erased_at timestamptz;

create table gdpr_erasures (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null,          -- záznam zákazníka zůstává (anonymizovaný), kvůli vazbám a účetní integritě
  reason       text not null,          -- request | retention
  performed_by text not null,
  performed_at timestamptz not null default now()
);

insert into ai_policies (key, value, description) values
  ('gdpr.retention_months', '36', 'Po kolika měsících bez aktivity se zákazník bez souhlasu a bez otevřené/přijaté nabídky anonymizuje (0 = vypnuto)'),
  ('quote.pdf_seller',      '"BELETA Plus s.r.o."', 'Hlavička PDF nabídky – prodávající (řádky oddělte znakem |)'),
  ('quote.pdf_footer',      '""', 'Patička PDF nabídky (např. obchodní podmínky, kontakt)')
on conflict (key) do nothing;
