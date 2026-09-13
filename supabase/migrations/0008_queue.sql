-- 0008 Background job queue.
--
-- Supabase Queues is pgmq. Where the extension is available this migration
-- creates it and the two real queues. Where it is not (a local PGlite/plain
-- Postgres test copy), it installs a SQL implementation in the same `pgmq`
-- schema with the same function signatures and the same visibility-timeout
-- semantics, so worker code is byte-identical in both environments.
--
-- Semantics relied on by the worker:
--   * read(queue, vt, qty) hides a claimed message for `vt` seconds and
--     increments read_ct  -> a crashed worker's message becomes visible again;
--   * set_vt extends the lease while a long job is still making progress;
--   * archive keeps a completed/dead message for inspection;
--   * FOR UPDATE SKIP LOCKED means two workers never claim the same message.

do $mig$
declare
  have_pgmq boolean := false;
begin
  begin
    create extension if not exists pgmq;
    have_pgmq := true;
  exception when others then
    raise notice 'pgmq extension unavailable (%); installing SQL-compatible queue.', sqlerrm;
  end;

  if have_pgmq then
    perform pgmq.create('g3_runs');
    perform pgmq.create('g3_ingest');
    return;
  end if;

  create schema if not exists pgmq;

  create table if not exists pgmq.meta (
    queue_name text primary key,
    created_at timestamptz not null default now()
  );

  create table if not exists pgmq.messages (
    msg_id bigserial primary key,
    queue_name text not null,
    read_ct integer not null default 0,
    enqueued_at timestamptz not null default now(),
    vt timestamptz not null default now(),
    message jsonb
  );
  create index if not exists pgmq_messages_poll_idx on pgmq.messages(queue_name, vt, msg_id);

  create table if not exists pgmq.messages_archive (
    msg_id bigint primary key,
    queue_name text not null,
    read_ct integer not null default 0,
    enqueued_at timestamptz not null,
    vt timestamptz,
    archived_at timestamptz not null default now(),
    message jsonb
  );

  -- Real pgmq returns a composite type, not an inline RETURNS TABLE, because a
  -- `vt` OUT column would collide with the `vt` argument. Same shape here.
  do $t$
  begin
    create type pgmq.message_record as (
      msg_id bigint,
      read_ct integer,
      enqueued_at timestamptz,
      vt timestamptz,
      message jsonb
    );
  exception when duplicate_object then null;
  end $t$;

  execute $fn$
    create or replace function pgmq.create(p_queue text)
    returns void language plpgsql as $body$
    begin
      insert into pgmq.meta(queue_name) values (p_queue)
      on conflict (queue_name) do nothing;
    end;
    $body$;
  $fn$;

  execute $fn$
    create or replace function pgmq.send(p_queue text, p_msg jsonb, p_delay integer default 0)
    returns setof bigint language plpgsql as $body$
    begin
      return query
      insert into pgmq.messages (queue_name, vt, message)
      values (p_queue, now() + make_interval(secs => p_delay), p_msg)
      returning messages.msg_id;
    end;
    $body$;
  $fn$;

  -- Claims up to p_qty visible messages, hides them for p_vt seconds and bumps
  -- read_ct. SKIP LOCKED keeps two workers off the same message; the timeout is
  -- what makes a crashed worker's job reappear instead of vanishing.
  execute $fn$
    create or replace function pgmq.read(p_queue text, p_vt integer, p_qty integer default 1)
    returns setof pgmq.message_record language plpgsql as $body$
    begin
      return query
      with claimed as (
        select m.msg_id
        from pgmq.messages m
        where m.queue_name = p_queue
          and m.vt <= now()
        order by m.msg_id
        limit p_qty
        for update skip locked
      )
      update pgmq.messages m
      set read_ct = m.read_ct + 1,
          vt = now() + make_interval(secs => p_vt)
      where m.msg_id in (select c.msg_id from claimed c)
      returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message;
    end;
    $body$;
  $fn$;

  execute $fn$
    create or replace function pgmq.set_vt(p_queue text, p_msg_id bigint, p_vt integer)
    returns setof pgmq.message_record language plpgsql as $body$
    begin
      return query
      update pgmq.messages m
      set vt = now() + make_interval(secs => p_vt)
      where m.queue_name = p_queue
        and m.msg_id = p_msg_id
      returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message;
    end;
    $body$;
  $fn$;

  execute $fn$
    create or replace function pgmq.delete(p_queue text, p_msg_id bigint)
    returns boolean language plpgsql as $body$
    declare removed integer;
    begin
      delete from pgmq.messages m
      where m.queue_name = p_queue and m.msg_id = p_msg_id;
      get diagnostics removed = row_count;
      return removed > 0;
    end;
    $body$;
  $fn$;

  execute $fn$
    create or replace function pgmq.archive(p_queue text, p_msg_id bigint)
    returns boolean language plpgsql as $body$
    declare moved integer;
    begin
      with gone as (
        delete from pgmq.messages m
        where m.queue_name = p_queue and m.msg_id = p_msg_id
        returning m.msg_id, m.queue_name, m.read_ct, m.enqueued_at, m.vt, m.message
      )
      insert into pgmq.messages_archive (msg_id, queue_name, read_ct, enqueued_at, vt, message)
      select g.msg_id, g.queue_name, g.read_ct, g.enqueued_at, g.vt, g.message from gone g
      on conflict (msg_id) do nothing;
      get diagnostics moved = row_count;
      return moved > 0;
    end;
    $body$;
  $fn$;

  perform pgmq.create('g3_runs');
  perform pgmq.create('g3_ingest');
end $mig$;

grant usage on schema pgmq to service_role;
do $$
begin
  execute 'grant all on all tables in schema pgmq to service_role';
  execute 'grant all on all sequences in schema pgmq to service_role';
  execute 'grant execute on all functions in schema pgmq to service_role';
exception when others then
  raise notice 'pgmq grants skipped: %', sqlerrm;
end $$;
