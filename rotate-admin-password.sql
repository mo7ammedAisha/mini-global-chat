-- Run privately in Supabase SQL Editor. Do not commit your password.
-- Replace only the value assigned to chosen_admin_password.

do $$
declare
  chosen_admin_password text := 'CHANGE_THIS_ADMIN_PASSWORD';
begin
  if char_length(chosen_admin_password) < 20 or chosen_admin_password like 'CHANGE_%' then
    raise exception 'Choose a random admin password with at least 20 characters';
  end if;

  update public.chat_settings
  set admin_secret_hash = extensions.crypt(chosen_admin_password, extensions.gen_salt('bf'))
  where singleton = true;
end
$$;
