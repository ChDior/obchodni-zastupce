-- Skutečná spotřeba tokenů LLM (bez obsahu konverzací)
create table ai_llm_usage (
  id                 bigserial primary key,
  ts                 timestamptz not null default now(),
  request_id         text,
  conversation_id    uuid,
  agent              text not null,
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0
);
create index ai_llm_usage_ts_idx on ai_llm_usage (ts desc);
