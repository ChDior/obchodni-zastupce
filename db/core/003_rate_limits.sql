-- Sdílený rate limiter (více instancí aplikace nad jednou DB)
create table rate_limits (
  name         text not null,
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null,
  primary key (name, key, window_start)
);
