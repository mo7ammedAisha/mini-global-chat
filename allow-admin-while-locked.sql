-- Run this once in Supabase SQL Editor before deploying the matching frontend update.

drop function if exists public.send_chat_message(text, text, text);

create or replace function public.send_chat_message(
  p_username text,
  p_content text,
  p_kind text default 'message',
  p_admin_secret text default null
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

  if coalesce(chat_locked, false) and not public.admin_auth(coalesce(p_admin_secret, '')) then
    raise exception 'CHAT_LOCKED';
  end if;

  insert into public.messages (username, content, kind)
  values (btrim(p_username), btrim(p_content), p_kind)
  returning * into new_message;

  return new_message;
end;
$$;

revoke all on function public.send_chat_message(text, text, text, text) from public;
grant execute on function public.send_chat_message(text, text, text, text) to anon;
