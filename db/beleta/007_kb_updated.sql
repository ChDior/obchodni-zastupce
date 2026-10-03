alter table kb_documents add column updated_at timestamptz not null default now();
