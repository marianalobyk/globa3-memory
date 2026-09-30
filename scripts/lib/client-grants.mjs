/**
 * What the client roles (anon, authenticated) and the server role may do in the
 * public schema. Read-only catalog queries; used locally and against the test
 * Supabase project. Returns check results, prints nothing itself.
 *
 * Expected after migration 0018:
 *   anon           -- nothing on any application table, sequence or function;
 *   authenticated  -- SELECT only, and only on tables with RLS enabled; no
 *                     column-level write grant; no sequence privilege; EXECUTE
 *                     only on the RLS helper functions;
 *   service_role   -- full DML on every application table and EXECUTE on every
 *                     application function (the server and worker write as it);
 *   default ACLs   -- objects the migration role creates later give anon and
 *                     authenticated nothing.
 */
export const RLS_HELPERS = ['is_workspace_member', 'can_approve_in_workspace'];
const WRITE = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

export async function inspectClientGrants(client) {
  const tables = (await client.query(`
    select c.relname as name, c.relrowsecurity as rls,
           array(select privilege_type::text from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'authenticated' order by 1) as auth,
           array(select privilege_type::text from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon' order by 1) as anon,
           array(select privilege_type::text from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'service_role' order by 1) as service
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by 1`)).rows;
  const columns = (await client.query(`
    select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
     where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'`)).rows;
  const sequences = (await client.query(`
    select c.relname as name,
           has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'UPDATE') or has_sequence_privilege('anon', c.oid, 'SELECT') as anon,
           has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'UPDATE') or has_sequence_privilege('authenticated', c.oid, 'SELECT') as auth
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`)).rows;
  const functions = (await client.query(`
    select p.proname as name,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f','p')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     order by 1`)).rows;
  const defaults = (await client.query(`
    select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype as type, d.defaclacl::text as acl
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
     where n.nspname = 'public'`)).rows;
  const me = (await client.query('select current_user as role')).rows[0].role;
  return { tables, columns, sequences, functions, defaults, me };
}

export function checkClientGrants(inv) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });
  const list = (xs) => (xs.length ? xs.slice(0, 8).join(', ') + (xs.length > 8 ? ` …(+${xs.length - 8})` : '') : '');

  const authWrites = inv.tables.filter((t) => t.auth.some((p) => WRITE.includes(p)));
  check(`authenticated: no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any of ${inv.tables.length} tables`, authWrites.length === 0, list(authWrites.map((t) => `${t.name}[${t.auth.join(',')}]`)));
  const anonAny = inv.tables.filter((t) => t.anon.length > 0);
  check('anon: no privilege on any table', anonAny.length === 0, list(anonAny.map((t) => t.name)));
  check('no column-level write grant to anon or authenticated', inv.columns.length === 0, list(inv.columns.map((c) => `${c.table_name}.${c.column_name}:${c.grantee}:${c.privilege_type}`)));
  const selectWithoutRls = inv.tables.filter((t) => !t.rls && t.auth.includes('SELECT'));
  check('authenticated: SELECT only where RLS is enabled', selectWithoutRls.length === 0, list(selectWithoutRls.map((t) => t.name)));
  const rlsTables = inv.tables.filter((t) => t.rls);
  const readable = rlsTables.filter((t) => t.auth.includes('SELECT'));
  check('authenticated keeps SELECT on the RLS-protected application tables', readable.length === rlsTables.length && rlsTables.length > 0, `${readable.length}/${rlsTables.length}`);
  // schema_migrations is the migration runner's own bookkeeping; the server
  // never writes it, and a local database never granted it to service_role.
  const serviceMissing = inv.tables.filter((t) => t.name !== 'schema_migrations' && !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => t.service.includes(p)));
  check('service_role keeps SELECT/INSERT/UPDATE/DELETE on every application table', serviceMissing.length === 0, list(serviceMissing.map((t) => t.name)));
  const seqClient = inv.sequences.filter((s) => s.anon || s.auth);
  check(`sequences (${inv.sequences.length}): no USAGE/SELECT/UPDATE for anon or authenticated`, seqClient.length === 0, list(seqClient.map((s) => s.name)));
  const fnAnon = inv.functions.filter((f) => f.anon);
  check(`functions (${inv.functions.length}): anon cannot execute any`, fnAnon.length === 0, list(fnAnon.map((f) => f.name)));
  const fnAuthExtra = inv.functions.filter((f) => f.auth && !RLS_HELPERS.includes(f.name));
  const fnAuthMissing = inv.functions.filter((f) => !f.auth && RLS_HELPERS.includes(f.name));
  check('authenticated executes only the RLS helper functions', fnAuthExtra.length === 0 && fnAuthMissing.length === 0, list([...fnAuthExtra.map((f) => `extra:${f.name}`), ...fnAuthMissing.map((f) => `missing:${f.name}`)]));
  const fnService = inv.functions.filter((f) => !f.service);
  check('service_role executes every application function', fnService.length === 0, list(fnService.map((f) => f.name)));
  const clientDefaults = inv.defaults.filter((d) => d.owner === inv.me && /(^|[{,])(anon|authenticated)=[a-zA-Z]+\//.test(d.acl));
  check(`default privileges (objects created later by ${inv.me}) grant anon/authenticated nothing`, clientDefaults.length === 0, list(clientDefaults.map((d) => `${d.type}:${d.acl}`)));
  return results;
}

export function summariseGrants(inv) {
  const count = (pred) => inv.tables.filter(pred).length;
  return {
    tables: inv.tables.length,
    rlsTables: count((t) => t.rls),
    authenticatedWriteTables: count((t) => t.auth.some((p) => WRITE.includes(p))),
    authenticatedSelectTables: count((t) => t.auth.includes('SELECT')),
    anonTables: count((t) => t.anon.length > 0),
    columnWriteGrants: inv.columns.length,
    clientSequences: inv.sequences.filter((s) => s.anon || s.auth).length,
    anonFunctions: inv.functions.filter((f) => f.anon).length,
    authenticatedFunctions: inv.functions.filter((f) => f.auth).map((f) => f.name),
    otherOwnerDefaults: inv.defaults.filter((d) => d.owner !== inv.me).map((d) => `${d.owner}:${d.type}`),
  };
}
