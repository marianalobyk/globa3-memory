-- Links a Supabase Auth user to the Globa 3 workspace as its administrator.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="<UID from the dashboard>" \
--     -v email="maryana.lobyk.lm@gmail.com" -f scripts/prod-audit/create-admin.sql
--
-- The account itself is created in the Supabase Dashboard, which owns
-- authentication. This only records the application-side identity and the
-- workspace membership. No password is handled here.
begin;

insert into public.app_users (id, email, display_name)
values (:'uid'::uuid, :'email', 'Mariana')
on conflict (id) do update set email = excluded.email;

insert into public.workspace_members (workspace_id, user_id, role, can_approve)
select w.id, :'uid'::uuid, 'admin', true
  from public.workspaces w
 where w.slug = 'globa3'
on conflict (workspace_id, user_id) do update set role = 'admin', can_approve = true;

commit;
