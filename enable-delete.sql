-- Run this once in Supabase SQL Editor for an existing chat installation.

drop policy if exists "Anyone can delete messages" on public.messages;
create policy "Anyone can delete messages"
on public.messages for delete
to anon
using (true);

grant delete on table public.messages to anon;
