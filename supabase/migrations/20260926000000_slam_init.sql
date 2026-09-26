-- SLAM backend schema: song catalog, featured pairs, mashup lineage, realtime feed, cover art bucket.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.tracks (
  id                  text primary key,
  title               text not null,
  artist              text not null,
  itunes_search_term  text not null,
  bpm                 numeric not null check (bpm > 0),
  key_name            text not null,
  camelot             text not null check (camelot ~ '^(1[0-2]|[1-9])[AB]$'),
  downbeat_offset_sec numeric not null default 0,
  energy              numeric not null check (energy between 0 and 1),
  description         text not null,
  preview_url         text,
  created_at          timestamptz not null default now()
);

create table public.pairs (
  id         text primary key,
  track_a    text not null references public.tracks (id) on delete cascade,
  track_b    text not null references public.tracks (id) on delete cascade,
  featured   boolean not null default true,
  sort_order int,
  check (track_a <> track_b)
);

create index pairs_featured_sort_idx on public.pairs (sort_order) where featured;

-- Parents are either a track (text id) or an earlier mashup (uuid as text), so there
-- is no foreign key; the direct-mashup function checks that parents exist.
create table public.mashups (
  id            uuid primary key default gen_random_uuid(),
  parent_a_type text not null check (parent_a_type in ('track', 'mashup')),
  parent_a_id   text not null,
  parent_b_type text not null check (parent_b_type in ('track', 'mashup')),
  parent_b_id   text not null,
  physics       jsonb not null,
  params        jsonb not null,
  params_source text not null check (params_source in ('model', 'fallback')),
  title         text not null,
  art_prompt    text not null,
  art_url       text,
  device_name   text not null,
  created_at    timestamptz not null default now(),
  constraint mashups_parent_a_uuid check (
    parent_a_type <> 'mashup'
    or parent_a_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint mashups_parent_b_uuid check (
    parent_b_type <> 'mashup'
    or parent_b_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

create index mashups_created_at_idx on public.mashups (created_at desc);

-- ---------------------------------------------------------------------------
-- Lineage: every ancestor edge of a mashup, breadth-first.
-- Each row is one edge child -> parent. Each ancestor mashup is expanded once
-- (at its shallowest depth), so shared ancestors in a diamond don't blow up.
-- ---------------------------------------------------------------------------

create or replace function public.get_lineage(mashup_id uuid)
returns table (
  depth         int,
  child_id      uuid,
  slot          text,
  ancestor_type text,
  ancestor_id   text,
  title         text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  frontier uuid[] := array[mashup_id];
  seen     uuid[] := array[mashup_id];
  d        int    := 0;
begin
  while cardinality(frontier) > 0 loop
    d := d + 1;

    return query
      select d, m.id, p.slot, p.ptype, p.pid, coalesce(t.title, pm.title)
      from public.mashups m
      cross join lateral (
        values ('a', m.parent_a_type, m.parent_a_id),
               ('b', m.parent_b_type, m.parent_b_id)
      ) as p (slot, ptype, pid)
      left join public.tracks t on p.ptype = 'track' and t.id = p.pid
      -- CASE, not AND: Postgres doesn't guarantee AND short-circuits, and
      -- casting a track id like 'september-ewf' to uuid would raise.
      left join public.mashups pm on pm.id = case when p.ptype = 'mashup' then p.pid::uuid end
      where m.id = any (frontier)
      order by m.id, p.slot;

    select coalesce(array_agg(distinct x.parent_id), '{}'::uuid[])
      into frontier
    from (
      select case when m.parent_a_type = 'mashup' then m.parent_a_id::uuid end as parent_id
      from public.mashups m where m.id = any (frontier)
      union all
      select case when m.parent_b_type = 'mashup' then m.parent_b_id::uuid end
      from public.mashups m where m.id = any (frontier)
    ) x
    where x.parent_id is not null
      and not (x.parent_id = any (seen));

    seen := seen || frontier;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: anyone can read; only the service role (Edge Functions,
-- which bypass RLS) can write.
-- ---------------------------------------------------------------------------

alter table public.tracks  enable row level security;
alter table public.pairs   enable row level security;
alter table public.mashups enable row level security;

create policy "tracks are readable by everyone"  on public.tracks  for select to anon, authenticated using (true);
create policy "pairs are readable by everyone"   on public.pairs   for select to anon, authenticated using (true);
create policy "mashups are readable by everyone" on public.mashups for select to anon, authenticated using (true);

-- Defense in depth: even if a permissive policy is added later, clients can't write.
revoke insert, update, delete, truncate on public.tracks, public.pairs, public.mashups from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime feed
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.mashups;

-- ---------------------------------------------------------------------------
-- Storage: public bucket for cover art
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 10485760, array['image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
