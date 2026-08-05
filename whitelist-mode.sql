-- Replaces the shared room code with administrator-controlled session approval.
-- Run once after security-hardening.sql.

alter table public.chat_settings
add column if not exists whitelist_enabled boolean not null default true;

update public.chat_settings
set whitelist_enabled = true, locked = true
where singleton = true;

alter table public.chat_sessions add column if not exists short_id text;
alter table public.chat_sessions add column if not exists allowed boolean not null default false;
alter table public.chat_sessions add column if not exists is_typing boolean not null default false;
alter table public.chat_sessions add column if not exists typing_updated_at timestamptz;

update public.chat_sessions
set short_id = upper(substr(encode(extensions.digest(token_hash || random()::text, 'sha256'), 'hex'), 1, 8))
where short_id is null;

alter table public.chat_sessions alter column short_id set not null;
create unique index if not exists chat_sessions_short_id_idx on public.chat_sessions (short_id);

create table if not exists public.chat_session_open_limit (
  singleton boolean primary key default true check (singleton),
  window_started timestamptz not null default clock_timestamp(),
  session_count integer not null default 0
);

insert into public.chat_session_open_limit (singleton)
values (true)
on conflict (singleton) do update
set window_started = clock_timestamp(), session_count = 0;

alter table public.chat_session_open_limit enable row level security;
revoke all on table public.chat_session_open_limit from anon, authenticated;

drop function if exists public.get_chat_messages(text, integer);
drop function if exists public.get_chat_status(text);
drop function if exists public.validate_chat_session(text);
drop function if exists public.open_chat_session(text, text, text);
drop function if exists public.admin_set_access_code(text, text);
alter table public.chat_settings drop column if exists room_access_hash;
drop table if exists public.chat_rate_limits;

create or replace function public.open_chat_session(p_username text, p_visitor_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  plain_token text;
  generated_short_id text;
  open_window timestamptz;
  open_count integer;
  active_sessions integer;
  whitelist_on boolean;
begin
  if char_length(btrim(p_username)) not between 2 and 24
    or char_length(p_visitor_id) not between 10 and 100 then
    raise exception 'INVALID_SESSION';
  end if;

  delete from public.chat_sessions
  where expires_at < clock_timestamp()
     or (allowed = false and created_at < clock_timestamp() - interval '30 minutes');

  select window_started, session_count into open_window, open_count
  from public.chat_session_open_limit where singleton = true for update;

  if open_window < clock_timestamp() - interval '1 minute' then
    update public.chat_session_open_limit
    set window_started = clock_timestamp(), session_count = 1
    where singleton = true;
  elsif open_count >= 30 then
    raise exception 'SESSION_CREATION_LIMIT';
  else
    update public.chat_session_open_limit
    set session_count = session_count + 1
    where singleton = true;
  end if;

  select count(*) into active_sessions
  from public.chat_sessions where expires_at >= clock_timestamp();
  if active_sessions >= 60 then raise exception 'ROOM_SESSION_LIMIT'; end if;

  select whitelist_enabled into whitelist_on
  from public.chat_settings where singleton = true;

  plain_token := encode(extensions.gen_random_bytes(32), 'hex');
  generated_short_id := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 8));

  insert into public.chat_sessions (
    token_hash, short_id, username, visitor_hash, allowed
  ) values (
    encode(extensions.digest(plain_token, 'sha256'), 'hex'),
    generated_short_id,
    btrim(p_username),
    encode(extensions.digest(p_visitor_id, 'sha256'), 'hex'),
    not coalesce(whitelist_on, true)
  );

  return jsonb_build_object(
    'token', plain_token,
    'short_id', generated_short_id,
    'username', btrim(p_username)
  );
end;
$$;

create or replace function public.validate_chat_session(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.chat_sessions;
  whitelist_on boolean;
begin
  update public.chat_sessions
  set last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
  returning * into session_row;

  if not found then return null; end if;
  select whitelist_enabled into whitelist_on from public.chat_settings where singleton = true;

  return jsonb_build_object(
    'username', session_row.username,
    'short_id', session_row.short_id,
    'allowed', session_row.allowed or not coalesce(whitelist_on, true)
  );
end;
$$;

create or replace function public.get_chat_messages(p_session_token text, p_limit integer default 100)
returns setof public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_info jsonb;
begin
  session_info := public.validate_chat_session(p_session_token);
  if session_info is null then raise exception 'SESSION_INVALID'; end if;
  if not (session_info->>'allowed')::boolean then raise exception 'SESSION_NOT_ALLOWED'; end if;

  return query
  select recent.* from (
    select m.* from public.messages m
    order by m.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) recent
  order by recent.created_at asc;
end;
$$;

create or replace function public.get_chat_state(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.chat_sessions;
  settings_row public.chat_settings;
  active_names jsonb;
  typing_names jsonb;
begin
  update public.chat_sessions
  set last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
  returning * into session_row;
  if not found then raise exception 'SESSION_INVALID'; end if;

  select * into settings_row from public.chat_settings where singleton = true;

  select coalesce(jsonb_agg(distinct username), '[]'::jsonb) into active_names
  from public.chat_sessions
  where expires_at >= clock_timestamp()
    and last_seen_at >= clock_timestamp() - interval '15 seconds'
    and (allowed = true or settings_row.whitelist_enabled = false);

  select coalesce(jsonb_agg(distinct username), '[]'::jsonb) into typing_names
  from public.chat_sessions
  where expires_at >= clock_timestamp()
    and is_typing = true
    and typing_updated_at >= clock_timestamp() - interval '3 seconds'
    and (allowed = true or settings_row.whitelist_enabled = false);

  return jsonb_build_object(
    'locked', settings_row.locked,
    'whitelist_enabled', settings_row.whitelist_enabled,
    'allowed', session_row.allowed or settings_row.whitelist_enabled = false,
    'short_id', session_row.short_id,
    'active_names', active_names,
    'typing_names', case when settings_row.locked then '[]'::jsonb else typing_names end
  );
end;
$$;

create or replace function public.set_chat_typing(p_session_token text, p_is_typing boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  whitelist_on boolean;
  chat_locked boolean;
begin
  select whitelist_enabled, locked into whitelist_on, chat_locked
  from public.chat_settings where singleton = true;

  update public.chat_sessions
  set is_typing = case when chat_locked then false else p_is_typing end,
      typing_updated_at = clock_timestamp(),
      last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
    and (allowed = true or whitelist_on = false);

  if not found then raise exception 'SESSION_NOT_ALLOWED'; end if;
  return not chat_locked and p_is_typing;
end;
$$;

create or replace function public.rename_chat_session(p_session_token text, p_username text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(btrim(p_username)) not between 2 and 24 then raise exception 'INVALID_NAME'; end if;
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
  settings_row public.chat_settings;
  global_window timestamptz;
  global_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if char_length(btrim(p_content)) not between 1 and 500
    or p_kind not in ('message', 'action') then raise exception 'INVALID_MESSAGE'; end if;

  select * into session_row from public.chat_sessions
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= v_now for update;
  if not found then raise exception 'SESSION_INVALID'; end if;

  select * into settings_row from public.chat_settings where singleton = true;
  if settings_row.locked then raise exception 'CHAT_LOCKED'; end if;
  if settings_row.whitelist_enabled and not session_row.allowed then
    raise exception 'SESSION_NOT_ALLOWED';
  end if;

  if session_row.last_message_at > v_now - interval '1 second' then
    raise exception 'SLOW_DOWN';
  end if;

  if session_row.window_started < v_now - interval '1 minute' then
    update public.chat_sessions
    set window_started = v_now, message_count = 1,
        last_message_at = v_now, last_seen_at = v_now
    where token_hash = session_row.token_hash;
  elsif session_row.message_count >= 12 then
    raise exception 'RATE_LIMIT';
  else
    update public.chat_sessions
    set message_count = message_count + 1,
        last_message_at = v_now, last_seen_at = v_now
    where token_hash = session_row.token_hash;
  end if;

  select window_started, message_count into global_window, global_count
  from public.chat_global_rate_limit where singleton = true for update;
  if global_window < v_now - interval '1 minute' then
    update public.chat_global_rate_limit
    set window_started = v_now, message_count = 1 where singleton = true;
  elsif global_count >= 60 then
    raise exception 'GLOBAL_RATE_LIMIT';
  else
    update public.chat_global_rate_limit
    set message_count = message_count + 1 where singleton = true;
  end if;

  insert into public.messages (username, content, kind)
  values (session_row.username, btrim(p_content), p_kind)
  returning * into new_message;
  return new_message;
end;
$$;

create or replace function public.admin_set_whitelist(p_secret text, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  update public.chat_settings set whitelist_enabled = p_enabled where singleton = true;
  return p_enabled;
end;
$$;

create or replace function public.admin_list_active_sessions(p_secret text)
returns table(short_id text, username text, allowed boolean, last_seen_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  return query select s.short_id, s.username, s.allowed, s.last_seen_at
  from public.chat_sessions s
  where s.expires_at >= clock_timestamp()
    and s.last_seen_at >= clock_timestamp() - interval '5 minutes'
  order by s.last_seen_at desc;
end;
$$;

create or replace function public.admin_set_session_allowed(
  p_secret text, p_identifier text, p_allowed boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
  exact_id boolean;
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;

  select exists (
    select 1 from public.chat_sessions
    where upper(short_id) = upper(p_identifier) and expires_at >= clock_timestamp()
  ) into exact_id;

  if exact_id then
    update public.chat_sessions set allowed = p_allowed
    where upper(short_id) = upper(p_identifier) and expires_at >= clock_timestamp();
  else
    if (select count(*) from public.chat_sessions
        where lower(username) = lower(p_identifier) and expires_at >= clock_timestamp()) > 1 then
      raise exception 'AMBIGUOUS_NAME_USE_ID';
    end if;
    update public.chat_sessions set allowed = p_allowed
    where lower(username) = lower(p_identifier) and expires_at >= clock_timestamp();
  end if;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.admin_list_allowed_sessions(p_secret text)
returns table(short_id text, username text, last_seen_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  return query select s.short_id, s.username, s.last_seen_at
  from public.chat_sessions s
  where s.allowed = true and s.expires_at >= clock_timestamp()
  order by s.username;
end;
$$;

create or replace function public.admin_set_all_sessions_allowed(p_secret text, p_allowed boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  update public.chat_sessions set allowed = p_allowed where expires_at >= clock_timestamp();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.admin_clear_pending_sessions(p_secret text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;
  delete from public.chat_sessions where allowed = false and token_hash is not null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.open_chat_session(text, text) from public;
revoke all on function public.validate_chat_session(text) from public;
revoke all on function public.get_chat_messages(text, integer) from public;
revoke all on function public.get_chat_state(text) from public;
revoke all on function public.set_chat_typing(text, boolean) from public;
revoke all on function public.rename_chat_session(text, text) from public;
revoke all on function public.send_chat_message(text, text, text) from public;
revoke all on function public.admin_set_whitelist(text, boolean) from public;
revoke all on function public.admin_list_active_sessions(text) from public;
revoke all on function public.admin_set_session_allowed(text, text, boolean) from public;
revoke all on function public.admin_list_allowed_sessions(text) from public;
revoke all on function public.admin_set_all_sessions_allowed(text, boolean) from public;
revoke all on function public.admin_clear_pending_sessions(text) from public;

grant execute on function public.open_chat_session(text, text) to anon;
grant execute on function public.validate_chat_session(text) to anon;
grant execute on function public.get_chat_messages(text, integer) to anon;
grant execute on function public.get_chat_state(text) to anon;
grant execute on function public.set_chat_typing(text, boolean) to anon;
grant execute on function public.rename_chat_session(text, text) to anon;
grant execute on function public.send_chat_message(text, text, text) to anon;
grant execute on function public.admin_set_whitelist(text, boolean) to anon;
grant execute on function public.admin_list_active_sessions(text) to anon;
grant execute on function public.admin_set_session_allowed(text, text, boolean) to anon;
grant execute on function public.admin_list_allowed_sessions(text) to anon;
grant execute on function public.admin_set_all_sessions_allowed(text, boolean) to anon;
grant execute on function public.admin_clear_pending_sessions(text) to anon;
