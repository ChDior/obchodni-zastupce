-- Číslování nabídek po letech (N-RRRR-0001, každý rok od 1)
create table quote_counters (
  year integer primary key,
  last integer not null
);
insert into quote_counters (year, last)
  select substring(number from 3 for 4)::int, max(substring(number from 8)::int)
  from quotes where number ~ '^N-[0-9]{4}-[0-9]+$' group by 1;
