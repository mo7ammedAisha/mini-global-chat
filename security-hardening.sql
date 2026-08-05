-- Complete security migration for the chat.
-- The temporary access hash is removed by whitelist-mode.sql.

create extension if not exists pgcrypto with schema extensions;

alter table public.chat_settings
add column if not exists room_access_hash text;

do $$
declare
  chosen_access_code text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  update public.chat_settings
  set room_access_hash = encode(extensions.digest(chosen_access_code, 'sha256'), 'hex'),
      locked = true
  where singleton = true;
end
$$;

alter table public.chat_settings
alter column room_access_hash set not null;

create table if not exists public.chat_sessions (
  token_hash text primary key,
  username text not null check (char_length(btrim(username)) between 2 and 24),
  visitor_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  last_seen_at timestamptz not null default clock_timestamp(),
  window_started timestamptz not null default clock_timestamp(),
  message_count integer not null default 0,
  last_message_at timestamptz
);

create table if not exists public.chat_global_rate_limit (
  singleton boolean primary key default true check (singleton),
  window_started timestamptz not null default clock_timestamp(),
  message_count integer not null default 0
);

insert into public.chat_global_rate_limit (singleton)
values (true)
on conflict (singleton) do update
set window_started = clock_timestamp(), message_count = 0;

alter table public.chat_sessions enable row level security;
alter table public.chat_global_rate_limit enable row level security;
revoke all on table public.chat_sessions from anon, authenticated;
revoke all on table public.chat_global_rate_limit from anon, authenticated;

drop policy if exists "Anyone can read messages" on public.messages;
revoke select, insert, update, delete on table public.messages from anon, authenticated;

drop function if exists public.send_chat_message(text, text, text, text);
drop function if exists public.send_chat_message(text, text, text, text, text, text);

create or replace function public.open_chat_session(
  p_access_code text,
  p_username text,
  p_visitor_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  plain_token text;
  active_sessions integer;
begin
  if not exists (
    select 1 from public.chat_settings
    where singleton = true
      and room_access_hash = encode(extensions.digest(p_access_code, 'sha256'), 'hex')
  ) then
    raise exception 'ACCESS_DENIED';
  end if;

  if char_length(btrim(p_username)) not between 2 and 24
    or char_length(p_visitor_id) not between 10 and 100 then
    raise exception 'INVALID_SESSION';
  end if;

  delete from public.chat_sessions
  where expires_at < clock_timestamp();

  select count(*) into active_sessions
  from public.chat_sessions
  where expires_at >= clock_timestamp();

  if active_sessions >= 30 then
    raise exception 'ROOM_SESSION_LIMIT';
  end if;

  plain_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.chat_sessions (token_hash, username, visitor_hash)
  values (
    encode(extensions.digest(plain_token, 'sha256'), 'hex'),
    btrim(p_username),
    encode(extensions.digest(p_visitor_id, 'sha256'), 'hex')
  );

  return plain_token;
end;
$$;

create or replace function public.validate_chat_session(p_session_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_username text;
begin
  update public.chat_sessions
  set last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
  returning username into session_username;
  return session_username;
end;
$$;

create or replace function public.get_chat_messages(p_session_token text, p_limit integer default 100)
returns setof public.messages
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.validate_chat_session(p_session_token) is null then
    raise exception 'SESSION_INVALID';
  end if;

  return query
  select recent.* from (
    select m.*
    from public.messages m
    order by m.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) recent
  order by recent.created_at asc;
end;
$$;

create or replace function public.get_chat_status(p_session_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  chat_locked boolean;
begin
  if public.validate_chat_session(p_session_token) is null then
    raise exception 'SESSION_INVALID';
  end if;

  select locked into chat_locked
  from public.chat_settings
  where singleton = true;
  return coalesce(chat_locked, true);
end;
$$;

create or replace function public.rename_chat_session(p_session_token text, p_username text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(btrim(p_username)) not between 2 and 24 then
    raise exception 'INVALID_NAME';
  end if;

  update public.chat_sessions
  set username = btrim(p_username), last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp();

  if not found then raise exception 'SESSION_INVALID'; end if;
  return true;
end;
$$;

create or replace function public.send_chat_message(
  p_session_token text,
  p_content text,
  p_kind text default 'message'
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_message public.messages;
  session_row public.chat_sessions;
  chat_locked boolean;
  global_window timestamptz;
  global_count integer;
  current_time timestamptz := clock_timestamp();
begin
  if char_length(btrim(p_content)) not between 1 and 500
    or p_kind not in ('message', 'action') then
    raise exception 'INVALID_MESSAGE';
  end if;

  select * into session_row
  from public.chat_sessions
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= current_time
  for update;

  if not found then raise exception 'SESSION_INVALID'; end if;

  select locked into chat_locked
  from public.chat_settings
  where singleton = true;
  if coalesce(chat_locked, true) then raise exception 'CHAT_LOCKED'; end if;

  if session_row.last_message_at > current_time - interval '1 second' then
    raise exception 'SLOW_DOWN';
  end if;

  if session_row.window_started < current_time - interval '1 minute' then
    update public.chat_sessions
    set window_started = current_time, message_count = 1,
        last_message_at = current_time, last_seen_at = current_time
    where token_hash = session_row.token_hash;
  elsif session_row.message_count >= 12 then
    raise exception 'RATE_LIMIT';
  else
    update public.chat_sessions
    set message_count = message_count + 1,
        last_message_at = current_time, last_seen_at = current_time
    where token_hash = session_row.token_hash;
  end if;

  select window_started, message_count into global_window, global_count
  from public.chat_global_rate_limit
  where singleton = true
  for update;

  if global_window < current_time - interval '1 minute' then
    update public.chat_global_rate_limit
    set window_started = current_time, message_count = 1
    where singleton = true;
  elsif global_count >= 60 then
    raise exception 'GLOBAL_RATE_LIMIT';
  else
    update public.chat_global_rate_limit
    set message_count = message_count + 1
    where singleton = true;
  end if;

  insert into public.messages (username, content, kind)
  values (session_row.username, btrim(p_content), p_kind)
  returning * into new_message;
  return new_message;
end;
$$;

create or replace function public.admin_set_access_code(p_secret text, p_access_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  if char_length(p_access_code) < 20 then raise exception 'ACCESS_CODE_TOO_SHORT'; end if;

  update public.chat_settings
  set room_access_hash = encode(extensions.digest(p_access_code, 'sha256'), 'hex'), locked = true
  where singleton = true;
  delete from public.chat_sessions where token_hash is not null;
  return true;
end;
$$;

create or replace function public.admin_purge_bot_messages(p_secret text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  delete from public.messages where username like 'Bot\_%' escape '\';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.open_chat_session(text, text, text) from public;
revoke all on function public.validate_chat_session(text) from public;
revoke all on function public.get_chat_messages(text, integer) from public;
revoke all on function public.get_chat_status(text) from public;
revoke all on function public.rename_chat_session(text, text) from public;
revoke all on function public.send_chat_message(text, text, text) from public;
revoke all on function public.admin_set_access_code(text, text) from public;
revoke all on function public.admin_purge_bot_messages(text) from public;
grant execute on function public.open_chat_session(text, text, text) to anon;
grant execute on function public.validate_chat_session(text) to anon;
grant execute on function public.get_chat_messages(text, integer) to anon;
grant execute on function public.get_chat_status(text) to anon;
grant execute on function public.rename_chat_session(text, text) to anon;
grant execute on function public.send_chat_message(text, text, text) to anon;
grant execute on function public.admin_set_access_code(text, text) to anon;
grant execute on function public.admin_purge_bot_messages(text) to anon;
