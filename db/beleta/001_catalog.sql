-- BELETA: produkty, ceny, sklad, kalkulační pravidla, doprava

create table products (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null unique,
  name        text not null,
  description text not null default '',
  category    text not null default 'ostatni',
  unit        text not null default 'ks',          -- jednotka prodeje (ks, m2, bal, pal)
  weight_kg   numeric(10,3) not null default 0,    -- hmotnost jedné jednotky
  attributes  jsonb not null default '{}',         -- technické parametry (jediný zdroj pravdy)
  search_text text not null default '',            -- normalizovaný text pro vyhledávání (bez diakritiky)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index products_category_idx on products (category) where active;

create table prices (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  price_list  text not null default 'retail',
  amount_net  numeric(12,2) not null check (amount_net >= 0),
  currency    text not null default 'CZK',
  vat_rate    numeric(5,2) not null default 21,
  valid_from  date not null default current_date,
  valid_to    date
);
create index prices_lookup_idx on prices (product_id, price_list, valid_from desc);

create table stock (
  product_id    uuid primary key references products(id) on delete cascade,
  qty_available numeric(12,3) not null default 0,
  qty_reserved  numeric(12,3) not null default 0,
  lead_time_days integer not null default 14,      -- dodací lhůta, pokud není skladem
  restock_date  date,
  source        text not null default 'manual',
  updated_at    timestamptz not null default now()
);

-- kolik jednotek produktu je třeba na 1 m2 (kryté plochy)
create table calc_rules (
  product_id         uuid primary key references products(id) on delete cascade,
  consumption_per_m2 numeric(12,4) not null check (consumption_per_m2 > 0),
  waste_pct          numeric(5,2) not null default 5,
  pack_size          numeric(12,3) not null default 1,   -- prodává se po baleních / paletách
  pack_label         text not null default 'ks',
  note               text
);

create table accessory_rules (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null references products(id) on delete cascade,
  accessory_product_id uuid not null references products(id) on delete cascade,
  basis                text not null check (basis in ('per_m2','per_unit')),
  factor               numeric(12,4) not null check (factor > 0),
  waste_pct            numeric(5,2) not null default 0,
  note                 text,
  unique (product_id, accessory_product_id)
);

create table shipping_zones (
  prefix text primary key,        -- začátek PSČ (např. '1', '60', '' = výchozí)
  zone   text not null
);
create table shipping_rates (
  id            uuid primary key default gen_random_uuid(),
  zone          text not null,
  max_weight_kg numeric(10,2) not null,
  price_net     numeric(12,2) not null,
  label         text not null default ''
);
create index shipping_rates_zone_idx on shipping_rates (zone, max_weight_kg);

create table kb_documents (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  source     text not null default 'manual',
  category   text not null default 'general',
  content    text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (title)
);
create table kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  ord         integer not null,
  content     text not null,
  norm        text not null
);
create index kb_chunks_doc_idx on kb_chunks (document_id, ord);
