-- Run this once in Supabase SQL Editor.
-- IMPORTANT: Replace CHANGE_THIS_ADMIN_PASSWORD before running.

create extension if not exists pgcrypto with schema extensions;

alter table public.messages
add column if not exists kind text not null default 'message';

alter table public.messages
drop constraint if exists messages_kind_check;

alter table public.messages
add constraint messages_kind_check
check (kind in ('message', 'action', 'announcement'));

create table if not exists public.chat_settings (
  singleton boolean primary key default true check (singleton),
  admin_secret_hash text not null,
  locked boolean not null default false
);

alter table public.chat_settings enable row level security;
revoke all on table public.chat_settings from anon, authenticated;

do $$
declare
  chosen_secret text := 'Admin-password';
begin
  if chosen_secret = 'CHANGE_THIS_ADMIN_PASSWORD' or char_length(chosen_secret) < 16 then
    raise exception 'Replace CHANGE_THIS_ADMIN_PASSWORD with at least 16 characters';
  end if;

  insert into public.chat_settings (singleton, admin_secret_hash, locked)
  values (true, extensions.crypt(chosen_secret, extensions.gen_salt('bf')), false)
  on conflict (singleton) do update
  set admin_secret_hash = excluded.admin_secret_hash;
end
$$;

drop policy if exists "Anyone can send messages" on public.messages;
drop policy if exists "Anyone can delete messages" on public.messages;
revoke insert, update, delete on table public.messages from anon, authenticated;

create or replace function public.admin_auth(p_secret text)
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
      and admin_secret_hash = extensions.crypt(p_secret, admin_secret_hash)
  );
$$;

create or replace function public.send_chat_message(
  p_username text,
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
  chat_locked boolean;
begin
  if char_length(btrim(p_username)) not between 2 and 24
    or char_length(btrim(p_content)) not between 1 and 500
    or p_kind not in ('message', 'action') then
    raise exception 'INVALID_MESSAGE';
  end if;

  select locked into chat_locked
  from public.chat_settings
  where singleton = true;

  if coalesce(chat_locked, false) then
    raise exception 'CHAT_LOCKED';
  end if;

  insert into public.messages (username, content, kind)
  values (btrim(p_username), btrim(p_content), p_kind)
  returning * into new_message;

  return new_message;
end;
$$;

create or replace function public.admin_clear_chat(p_secret text)
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
  where id is not null;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.admin_delete_message(p_secret text, p_message_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_id bigint;
begin
  if not public.admin_auth(p_secret) then
    raise exception 'INVALID_ADMIN_SECRET';
  end if;

  delete from public.messages
  where id = p_message_id
  returning id into deleted_id;

  return deleted_id is not null;
end;
$$;

create or replace function public.admin_set_lock(p_secret text, p_locked boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.admin_auth(p_secret) then
    raise exception 'INVALID_ADMIN_SECRET';
  end if;

  update public.chat_settings
  set locked = p_locked
  where singleton = true;

  return p_locked;
end;
$$;

create or replace function public.admin_announce(p_secret text, p_content text)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_message public.messages;
begin
  if not public.admin_auth(p_secret) then
    raise exception 'INVALID_ADMIN_SECRET';
  end if;

  if char_length(btrim(p_content)) not between 1 and 500 then
    raise exception 'INVALID_MESSAGE';
  end if;

  insert into public.messages (username, content, kind)
  values ('الإدارة', btrim(p_content), 'announcement')
  returning * into new_message;

  return new_message;
end;
$$;

revoke all on function public.admin_auth(text) from public;
revoke all on function public.send_chat_message(text, text, text) from public;
revoke all on function public.admin_clear_chat(text) from public;
revoke all on function public.admin_delete_message(text, bigint) from public;
revoke all on function public.admin_set_lock(text, boolean) from public;
revoke all on function public.admin_announce(text, text) from public;

grant execute on function public.admin_auth(text) to anon;
grant execute on function public.send_chat_message(text, text, text) to anon;
grant execute on function public.admin_clear_chat(text) to anon;
grant execute on function public.admin_delete_message(text, bigint) to anon;
grant execute on function public.admin_set_lock(text, boolean) to anon;
grant execute on function public.admin_announce(text, text) to anon;
