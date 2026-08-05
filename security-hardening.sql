-- Emergency hardening for an existing chat installation.
-- Replace only the value assigned to chosen_access_code before running.

create extension if not exists pgcrypto with schema extensions;

alter table public.chat_settings
add column if not exists room_access_hash text;

do $$
declare
  chosen_access_code text := 'CHANGE_THIS_ROOM_ACCESS_CODE';
begin
  if char_length(chosen_access_code) < 20 or chosen_access_code like 'CHANGE_%' then
    raise exception 'Choose a private room access code with at least 20 characters';
  end if;

  update public.chat_settings
  set room_access_hash = encode(extensions.digest(chosen_access_code, 'sha256'), 'hex')
  where singleton = true;
end
$$;

alter table public.chat_settings
alter column room_access_hash set not null;

create table if not exists public.chat_rate_limits (
  visitor_hash text primary key,
  window_started timestamptz not null default clock_timestamp(),
  message_count integer not null default 0,
  last_message_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.chat_global_rate_limit (
  singleton boolean primary key default true check (singleton),
  window_started timestamptz not null default clock_timestamp(),
  message_count integer not null default 0
);

insert into public.chat_global_rate_limit (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.chat_rate_limits enable row level security;
alter table public.chat_global_rate_limit enable row level security;
revoke all on table public.chat_rate_limits from anon, authenticated;
revoke all on table public.chat_global_rate_limit from anon, authenticated;

create or replace function public.verify_room_access(p_access_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chat_settings
    where singleton = true
      and room_access_hash = encode(extensions.digest(p_access_code, 'sha256'), 'hex')
  );
$$;

drop function if exists public.send_chat_message(text, text, text, text);

create or replace function public.send_chat_message(
  p_username text,
  p_content text,
  p_kind text,
  p_admin_secret text,
  p_access_code text,
  p_visitor_id text
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_message public.messages;
  chat_locked boolean;
  visitor_key text;
  visitor_window timestamptz;
  visitor_count integer;
  visitor_last_message timestamptz;
  global_window timestamptz;
  global_count integer;
  current_time timestamptz := clock_timestamp();
begin
  if not public.verify_room_access(p_access_code) then
    raise exception 'ACCESS_DENIED';
  end if;

  if char_length(btrim(p_username)) not between 2 and 24
    or char_length(btrim(p_content)) not between 1 and 500
    or p_kind not in ('message', 'action')
    or char_length(p_visitor_id) not between 10 and 100 then
    raise exception 'INVALID_MESSAGE';
  end if;

  select locked into chat_locked
  from public.chat_settings
  where singleton = true;

  if coalesce(chat_locked, false) and not public.admin_auth(coalesce(p_admin_secret, '')) then
    raise exception 'CHAT_LOCKED';
  end if;

  select window_started, message_count
  into global_window, global_count
  from public.chat_global_rate_limit
  where singleton = true
  for update;

  if global_window < current_time - interval '1 minute' then
    update public.chat_global_rate_limit
    set window_started = current_time, message_count = 1
    where singleton = true;
  elsif global_count >= 80 then
    raise exception 'GLOBAL_RATE_LIMIT';
  else
    update public.chat_global_rate_limit
    set message_count = message_count + 1
    where singleton = true;
  end if;

  visitor_key := encode(extensions.digest(p_visitor_id, 'sha256'), 'hex');
  insert into public.chat_rate_limits (visitor_hash)
  values (visitor_key)
  on conflict (visitor_hash) do nothing;

  select window_started, message_count, last_message_at
  into visitor_window, visitor_count, visitor_last_message
  from public.chat_rate_limits
  where visitor_hash = visitor_key
  for update;

  if visitor_last_message > current_time - interval '750 milliseconds' then
    raise exception 'SLOW_DOWN';
  end if;

  if visitor_window < current_time - interval '1 minute' then
    update public.chat_rate_limits
    set window_started = current_time,
        message_count = 1,
        last_message_at = current_time,
        updated_at = current_time
    where visitor_hash = visitor_key;
  elsif visitor_count >= 15 then
    raise exception 'RATE_LIMIT';
  else
    update public.chat_rate_limits
    set message_count = message_count + 1,
        last_message_at = current_time,
        updated_at = current_time
    where visitor_hash = visitor_key;
  end if;

  insert into public.messages (username, content, kind)
  values (btrim(p_username), btrim(p_content), p_kind)
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
  if not public.admin_auth(p_secret) then
    raise exception 'INVALID_ADMIN_SECRET';
  end if;

  if char_length(p_access_code) < 20 then
    raise exception 'ACCESS_CODE_TOO_SHORT';
  end if;

  update public.chat_settings
  set room_access_hash = encode(extensions.digest(p_access_code, 'sha256'), 'hex')
  where singleton = true;

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
  if not public.admin_auth(p_secret) then
    raise exception 'INVALID_ADMIN_SECRET';
  end if;

  delete from public.messages
  where username like 'Bot\_%' escape '\';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.verify_room_access(text) from public;
revoke all on function public.send_chat_message(text, text, text, text, text, text) from public;
revoke all on function public.admin_set_access_code(text, text) from public;
revoke all on function public.admin_purge_bot_messages(text) from public;
grant execute on function public.verify_room_access(text) to anon;
grant execute on function public.send_chat_message(text, text, text, text, text, text) to anon;
grant execute on function public.admin_set_access_code(text, text) to anon;
grant execute on function public.admin_purge_bot_messages(text) to anon;
