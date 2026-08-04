-- Run this file once in Supabase SQL Editor.

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  username text not null check (
    char_length(btrim(username)) between 2 and 24
  ),
  content text not null check (
    char_length(btrim(content)) between 1 and 500
  ),
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

drop policy if exists "Anyone can read messages" on public.messages;
create policy "Anyone can read messages"
on public.messages for select
to anon
using (true);

drop policy if exists "Anyone can send messages" on public.messages;
create policy "Anyone can send messages"
on public.messages for insert
to anon
with check (true);

drop policy if exists "Anyone can delete messages" on public.messages;
create policy "Anyone can delete messages"
on public.messages for delete
to anon
using (true);

grant usage on schema public to anon;
grant select, insert, delete on table public.messages to anon;
grant usage, select on sequence public.messages_id_seq to anon;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;

create index if not exists messages_created_at_idx
on public.messages (created_at desc);
