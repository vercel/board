-- The tables of a board on Postgres (@vercel/board/backend-postgres): those that keep
-- its log, then those it reads from, and its files. Apply this file before the first
-- deploy, and again when a board release says the tables changed. Every statement
-- creates only what is missing and leaves existing data alone, so it's safe to re-run.
-- The breakpoint after each statement splits it for migration tools that send one
-- statement per query; to every other tool it's only a comment.

-- A2's tables for experimental-a2/store-postgres. drizzle-schema.ts, next to
-- this file, shows the same tables as Drizzle definitions, as an example.
--
-- Apply this file before the first deploy, and again when a release's
-- changelog says the tables changed. Every statement creates only what is
-- missing and leaves existing data alone, so the file is safe to re-run on any
-- A2 database, whichever release created it. A2 checks nothing up front: a
-- query that finds a table or column missing throws STORE_NOT_CONFIGURED.
--
-- On a database from a release that ran handlers, it drops the work those
-- handlers hadn't finished, and the columns they dispatched by, so drain
-- earlier deployments and apply it while none is running.
--
-- Each index sits behind a catalog check: `create index if not exists` takes
-- a share lock on its table, and requires owning it, even when the index
-- exists. The check makes a re-run on a live database wait for no writer.
--
-- The file works as a migration as it ships: copy it into your migration
-- tool's folder. The breakpoint comment after each statement splits it for
-- tools that send one statement per query, like Drizzle on PGlite; to every
-- other tool, psql included, it's only a comment.

create table if not exists a2_events (
  session_id   text    not null,
  idx          bigint  not null,
  event_type   text    not null,
  payload      jsonb   not null,
  event_id     text    not null,
  created_at   bigint  not null,
  cause        jsonb,
  primary key (session_id, idx)
);
--> statement-breakpoint

-- One row per run of a cursor: an event cursor's one event, a lane's run of
-- queued events, or a log cursor's position. A run is keyed by the head it
-- started at (`epoch`), so a clear starts new runs instead of rewriting old
-- ones.
create table if not exists a2_cursors (
  session_id   text    not null,
  consumer     text    not null,
  cursor_key   text    not null,
  epoch        bigint  not null,
  lane         text,
  kind         text    not null,
  position     bigint  not null,
  head         bigint,
  types        jsonb,
  attempt_count integer not null default 0,
  first_claimed_at bigint,
  last_claimed_at bigint,
  claim_holder text,
  claim_expires_at bigint,
  failure_count integer not null default 0,
  last_failed_at bigint,
  last_failed_attempt integer,
  last_error   text,
  failed_at    bigint,
  completed_idx bigint,
  completed_attempt integer,
  returned_event_ids jsonb,
  primary key (session_id, cursor_key, consumer, epoch)
);
--> statement-breakpoint

-- A lane cursor's queue: the events appended for the lane, in log order.
create table if not exists a2_lane_events (
  session_id   text    not null,
  consumer     text    not null,
  lane         text    not null,
  idx          bigint  not null,
  done         boolean not null default false,
  completed_attempt integer,
  returned_event_ids jsonb,
  primary key (session_id, consumer, lane, idx)
);
--> statement-breakpoint

create table if not exists a2_snapshots (
  session_id   text   not null,
  reducer_name text   not null,
  up_to_index  bigint not null,
  state        jsonb  not null,
  updated_at   bigint not null,
  primary key (session_id, reducer_name)
);
--> statement-breakpoint

create table if not exists a2_snapshot_history (
  session_id   text   not null,
  reducer_name text   not null,
  up_to_index  bigint not null,
  state        jsonb  not null,
  updated_at   bigint not null,
  primary key (session_id, reducer_name, up_to_index)
);
--> statement-breakpoint

-- Earlier releases pinned snapshots per event; this one pins them per
-- cursor head. Pins only hold history for work in flight, so old ones go.
do $$ begin
  if to_regclass('a2_snapshot_pins') is not null and not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('a2_snapshot_pins')
       and attname = 'cursor_key' and not attisdropped
  ) then
    drop table a2_snapshot_pins;
  end if;
end $$;
--> statement-breakpoint

create table if not exists a2_snapshot_pins (
  session_id   text   not null,
  event_index  bigint not null,
  consumer     text   not null,
  cursor_key   text   not null,
  reducer_name text   not null,
  up_to_index  bigint not null,
  primary key (session_id, event_index, consumer, cursor_key, reducer_name, up_to_index)
);
--> statement-breakpoint

create table if not exists a2_clears (
  session_id  text   primary key,
  clear_index bigint not null
);
--> statement-breakpoint

create table if not exists a2_presence (
  ns          text   not null,
  participant text   not null,
  field       text   not null,
  value       jsonb  not null,
  seen        bigint not null,
  at          bigint not null,
  expires_at  bigint not null,
  primary key (ns, participant, field)
);
--> statement-breakpoint

-- From an earlier release: work its handlers hadn't finished is dropped,
-- since this release runs no handlers to finish it. Every event is kept.
-- Causes gain the dispatcher that appended them, the handlers table
-- (`a2.handlers`), and its lane. Then the old dispatch columns go, and
-- their indexes with them. The block locks the events first, so an earlier
-- release still writing waits and then fails, rather than committing between
-- its statements, and it commits whole, or not at all.
do $$ begin
  if exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('a2_events')
       and attname = 'processed_at' and not attisdropped
  ) then
    lock table a2_events in access exclusive mode;

    update a2_events child
       set cause = jsonb_build_object(
             'consumer', 'a2.handlers',
             'lane', (select parent.lane from a2_events parent
                       where parent.session_id = child.session_id
                         and parent.idx = (child.cause ->> 'index')::bigint)
           ) || child.cause
     where child.cause is not null and not child.cause ? 'consumer';

    alter table a2_events
      drop column lane,
      drop column lane_ready,
      drop column processed_at,
      drop column processed_by_attempt,
      drop column returned_event_ids,
      drop column first_claimed_at,
      drop column last_claimed_at,
      drop column attempt_count,
      drop column failure_count,
      drop column last_failed_at,
      drop column last_failed_attempt,
      drop column last_error,
      drop column failed_at,
      drop column claim_holder,
      drop column claim_expires_at;
  end if;
end $$;
--> statement-breakpoint

-- Earlier releases recorded a schema version here and checked it before
-- their first query. This one checks nothing up front.
drop table if exists a2_schema;
--> statement-breakpoint

-- Runs an operation's statements in one round trip: A2 sends each write that
-- takes a session's lock as one call, the lock and then the statements that
-- need it, so it holds the lock only while the server runs them. Each
-- statement takes its snapshot when it starts, so those after the lock see
-- what its last holder committed; a single statement can't, since its
-- snapshot predates the lock. Each statement is a select of jsonb rows: a row
-- with an `abort` key fails the call and rolls it back, and one with a `stop`
-- key ends it. It needs read committed, the default: under a stricter level
-- every statement would share the first one's snapshot, so it refuses to run.
-- Created only if missing, as the indexes are: a later release that changes it
-- adds a function with a new name.
do $$ declare grantee text; begin
  if to_regprocedure('a2_batch(text[], jsonb)') is null then
    create function a2_batch(statements text[], params jsonb)
    returns setof jsonb
    language plpgsql
    volatile
    as $batch$
    declare
      statement text;
      result jsonb;
    begin
      if current_setting('transaction_isolation') <> 'read committed' then
        raise exception using errcode = 'A2002',
          message = 'a2_batch needs the read committed isolation level';
      end if;
      foreach statement in array statements loop
        for result in execute statement using params loop
          if result ? 'abort' then
            raise exception using errcode = 'A2001',
              message = 'a2_batch aborted', detail = result::text;
          end if;
          return next result;
          if result ? 'stop' then
            return;
          end if;
        end loop;
      end loop;
    end
    $batch$;
    -- Default privileges can grant a new function to roles besides PUBLIC, as
    -- platforms that serve functions over an API grant theirs: it starts with
    -- none but its owner's. Grants made after it exist are left alone.
    for grantee in
      select acl.grantee::regrole::text
        from pg_proc proc, aclexplode(proc.proacl) acl
       where proc.oid = to_regprocedure('a2_batch(text[], jsonb)')
         and acl.grantee not in (0, proc.proowner)
    loop
      execute format('revoke execute on function a2_batch(text[], jsonb) from %s', grantee);
    end loop;
  end if;
  -- It runs any statement it's handed, as its caller: only its owner, the role
  -- that applies this file, may call it, and not every role, as Postgres lets
  -- by default. Platforms that serve functions over an API would serve it too.
  if pg_has_role(
    current_user,
    (select proowner from pg_proc
      where oid = to_regprocedure('a2_batch(text[], jsonb)')),
    'usage'
  ) then
    revoke execute on function a2_batch(text[], jsonb) from public;
  end if;
end $$;
--> statement-breakpoint

do $$ begin
  if to_regclass('a2_events_types') is null then
    create index if not exists a2_events_types
      on a2_events (session_id, event_type, idx);
  end if;
  if to_regclass('a2_cursors_heads') is null then
    create index if not exists a2_cursors_heads
      on a2_cursors (session_id, head) where head is not null;
  end if;
  if to_regclass('a2_cursors_lanes') is null then
    create index if not exists a2_cursors_lanes
      on a2_cursors (session_id) where kind = 'lane';
  end if;
  if to_regclass('a2_snapshot_pins_checkpoint') is null then
    create index if not exists a2_snapshot_pins_checkpoint
      on a2_snapshot_pins (session_id, reducer_name, up_to_index);
  end if;
end $$;
--> statement-breakpoint

-- Event ids are unique per session, through the index on (session_id,
-- event_id). It replaces a2_events_event_id, on event_id alone. The swap
-- locks the table before it builds, so it waits for running queries instead
-- of deadlocking with a writer when the whole file runs as one transaction.
-- The old index goes only once the new one is valid, so a session's ids
-- always have a unique index.
do $$ begin
  if to_regclass('a2_events_session_event_id') is null then
    if to_regclass('a2_events_event_id') is not null then
      lock table a2_events in access exclusive mode;
    end if;
    create unique index if not exists a2_events_session_event_id
      on a2_events (session_id, event_id);
  end if;
  if to_regclass('a2_events_event_id') is not null and exists (
    select 1 from pg_index
     where indexrelid = to_regclass('a2_events_session_event_id')
       and indisvalid and indisunique
  ) then
    drop index a2_events_event_id;
  end if;
end $$;
--> statement-breakpoint

create table if not exists board_positions (
  consumer text primary key,
  log_index bigint not null
);
--> statement-breakpoint
create table if not exists board_messages (
  id bigint primary key,
  event_id text not null unique,
  channel text not null,
  re bigint,
  by_actor text not null,
  by_principal text not null,
  by_profile text,
  from_key text,
  no_sync boolean not null,
  text_lower text not null,
  deleted boolean not null,
  created_at bigint not null,
  replies integer not null default 0,
  at bigint,
  data text not null
);
--> statement-breakpoint
create index if not exists board_messages_channel on board_messages (channel, id);
--> statement-breakpoint
create index if not exists board_messages_re on board_messages (re, id);
--> statement-breakpoint
create index if not exists board_messages_by_actor on board_messages (by_actor, id);
--> statement-breakpoint
create index if not exists board_messages_by_principal on board_messages (by_principal, id);
--> statement-breakpoint
create index if not exists board_threads_at on board_messages (at) where re is null;
--> statement-breakpoint
create index if not exists board_threads_channel on board_messages (channel, at) where re is null;
--> statement-breakpoint
create table if not exists board_versions (
  log_index bigint primary key,
  message_id bigint not null,
  data text not null
);
--> statement-breakpoint
create index if not exists board_versions_message on board_versions (message_id, log_index);
--> statement-breakpoint
create table if not exists board_terms (
  message_id bigint not null,
  term text not null,
  value text not null,
  primary key (message_id, term, value)
);
--> statement-breakpoint
create index if not exists board_terms_term on board_terms (term, value, message_id);
--> statement-breakpoint
create table if not exists board_sync_threads (
  thread text primary key,
  data text not null
);
--> statement-breakpoint
create table if not exists board_external_threads (
  external text primary key,
  thread text not null
);
--> statement-breakpoint
create table if not exists board_copies (
  message_id bigint not null,
  target text not null,
  data text not null,
  primary key (message_id, target)
);
--> statement-breakpoint
create table if not exists board_external_messages (
  key text primary key,
  message_id bigint not null
);
--> statement-breakpoint
drop index if exists board_messages_recent;
--> statement-breakpoint
create table if not exists board_meta (
  key text primary key,
  value text not null
);
--> statement-breakpoint
create table if not exists board_files (
  key text primary key,
  content_type text not null,
  data bytea not null
);
