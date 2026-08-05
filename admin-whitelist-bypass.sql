-- Lets an authenticated administrator session bypass Whitelist for one hour.
-- Run once after whitelist-mode.sql.

alter table public.chat_sessions
add column if not exists admin_until timestamptz;

create or replace function public.admin_elevate_session(
  p_secret text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then raise exception 'INVALID_ADMIN_SECRET'; end if;

  update public.chat_sessions
  set admin_until = clock_timestamp() + interval '1 hour',
      last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp();

  if not found then raise exception 'SESSION_INVALID'; end if;
  return true;
end;
$$;

create or replace function public.admin_demote_session(p_session_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chat_sessions
  set admin_until = null
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex');
  return found;
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
  session_is_admin boolean;
begin
  update public.chat_sessions
  set last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
  returning * into session_row;

  if not found then return null; end if;
  select whitelist_enabled into whitelist_on from public.chat_settings where singleton = true;
  session_is_admin := coalesce(session_row.admin_until >= clock_timestamp(), false);

  return jsonb_build_object(
    'username', session_row.username,
    'short_id', session_row.short_id,
    'is_admin', session_is_admin,
    'allowed', session_is_admin or session_row.allowed or not coalesce(whitelist_on, true)
  );
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
  session_is_admin boolean;
begin
  update public.chat_sessions
  set last_seen_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and expires_at >= clock_timestamp()
  returning * into session_row;
  if not found then raise exception 'SESSION_INVALID'; end if;

  select * into settings_row from public.chat_settings where singleton = true;
  session_is_admin := coalesce(session_row.admin_until >= clock_timestamp(), false);

  select coalesce(jsonb_agg(distinct username), '[]'::jsonb) into active_names
  from public.chat_sessions
  where expires_at >= clock_timestamp()
    and last_seen_at >= clock_timestamp() - interval '15 seconds'
    and (allowed = true or admin_until >= clock_timestamp() or settings_row.whitelist_enabled = false);

  select coalesce(jsonb_agg(distinct username), '[]'::jsonb) into typing_names
  from public.chat_sessions
  where expires_at >= clock_timestamp()
    and is_typing = true
    and typing_updated_at >= clock_timestamp() - interval '3 seconds'
    and (allowed = true or admin_until >= clock_timestamp() or settings_row.whitelist_enabled = false);

  return jsonb_build_object(
    'locked', settings_row.locked,
    'whitelist_enabled', settings_row.whitelist_enabled,
    'is_admin', session_is_admin,
    'allowed', session_is_admin or session_row.allowed or settings_row.whitelist_enabled = false,
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
    and (allowed = true or admin_until >= clock_timestamp() or whitelist_on = false);

  if not found then raise exception 'SESSION_NOT_ALLOWED'; end if;
  return not chat_locked and p_is_typing;
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
  if settings_row.whitelist_enabled and not session_row.allowed
    and not coalesce(session_row.admin_until >= v_now, false) then
    raise exception 'SESSION_NOT_ALLOWED';
  end if;

  if session_row.last_message_at > v_now - interval '1 second' then raise exception 'SLOW_DOWN'; end if;

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

revoke all on function public.admin_elevate_session(text, text) from public;
revoke all on function public.admin_demote_session(text) from public;
grant execute on function public.admin_elevate_session(text, text) to anon;
grant execute on function public.admin_demote_session(text) to anon;
