-- 2FA (TOTP) a správa uživatelů
alter table admin_users
  add column totp_secret     text,
  add column totp_enabled    boolean not null default false,
  add column totp_last_step  bigint,
  add column recovery_hashes jsonb not null default '[]';
