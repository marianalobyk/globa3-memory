import { writeFileSync } from 'node:fs';
import { readOnlyClient, rows } from './connect.mjs';
const client = await readOnlyClient();
const out = {};
try {
  out.schemas = await rows(client, `select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`);
  out.extensions = await rows(client, `select extname, extversion from pg_extension order by 1`);
  out.tables = await rows(client, `
    select c.relname as table, c.relkind, c.relrowsecurity as rls,
           (select count(*) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
           pg_total_relation_size(c.oid) as bytes
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','f')
    order by c.relkind, c.relname`);
  out.views = await rows(client, `select table_name, view_definition from information_schema.views where table_schema='public' order by 1`);
  out.enums = await rows(client, `
    select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' group by 1 order by 1`);
  out.functions = await rows(client, `
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' order by 1`);
  out.triggers = await rows(client, `
    select c.relname as table, t.tgname, pg_get_triggerdef(t.oid) as def
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal order by 1,2`);
  out.policies = await rows(client, `select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' order by 1,2`);
  out.foreignKeys = await rows(client, `
    select con.conname, src.relname as from_table, tgt.relname as to_table,
           pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class src on src.oid=con.conrelid
    join pg_class tgt on tgt.oid=con.confrelid
    join pg_namespace n on n.oid=src.relnamespace
    where con.contype='f' and n.nspname='public' order by 2,1`);
  out.constraints = await rows(client, `
    select c.relname as table, con.conname, con.contype, pg_get_constraintdef(con.oid) as def
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and con.contype in ('p','u','c') order by 1,3,2`);
  out.indexes = await rows(client, `select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`);
  out.columns = await rows(client, `
    select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema='public' order by table_name, ordinal_position`);
} finally { await client.end(); }
writeFileSync('scripts/prod-audit/out-inventory.json', JSON.stringify(out, null, 2));
console.log('schemas    :', out.schemas.map(r=>r.nspname).join(', '));
console.log('extensions :', out.extensions.map(r=>r.extname).join(', '));
console.log('\nTABLES (relkind r=table v=view m=matview):');
for (const t of out.tables) console.log(`  ${t.relkind}  ${String(t.table).padEnd(38)} cols=${String(t.columns).padStart(3)} rls=${t.rls ? 'Y':'n'} ${(Number(t.bytes)/1024).toFixed(0)}KB`);
console.log('\nenums:', out.enums.map(e=>e.typname).join(', ') || '(none)');
console.log('views:', out.views.map(v=>v.table_name).join(', ') || '(none)');
console.log('functions:', out.functions.length, '| triggers:', out.triggers.length, '| policies:', out.policies.length, '| FKs:', out.foreignKeys.length);
