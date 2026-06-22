-- ───────────────────────────────────────────────────────────────────────────
-- outlook-calendar-poc — Supabase schema setup
--
-- Run this once on a fresh / development Supabase project (SQL Editor) to give
-- the app everything it needs beyond the bis_* master tables:
--   • 3 read-only SQL functions the app calls (directory, analytics, search)
--   • the app_* platform tables (CRM activities, ingested emails, audit log)
--
-- Idempotent — safe to re-run. Assumes the bis_* tables already exist with the
-- same columns as production (physician_npi, total_volume TEXT, year, cpt_code,
-- procedure_category, payer_category, snare_used, facility_id, …).
-- ───────────────────────────────────────────────────────────────────────────

-- ── Function 1: bulk directory (physicians + facilities) in one round trip ──
create or replace function public.bis_directory()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'physicians', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'npi', physician_npi, 'name', physician_name, 'specialty', specialty,
        'email', email, 'phone', phone, 'esdProcedure', esd_procedure,
        'photoUrl', photo_url, 'linkedinUrl', linkedin_url,
        'primaryFacilityId', primary_facility_id
      )), '[]'::jsonb) from public.bis_physicians
    ),
    'facilities', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', facility_id, 'name', facility_name, 'type', facility_type,
        'address', address, 'city', city, 'state', state, 'zip', zip
      )), '[]'::jsonb) from public.bis_facilities
    )
  );
$$;

-- ── Function 2: all analytics sections for one NPI (null when no data) ───────
create or replace function public.bis_physician_analytics(p_npi text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case
    when coalesce((select sum(total_volume::numeric)
                   from public.bis_procedure_volumes where physician_npi = p_npi), 0) = 0
    then null
    else jsonb_build_object(
      'summary', (
        select jsonb_build_object(
          'totalVolume', sum(total_volume::numeric)::int,
          'firstYear', min(year)::int, 'lastYear', max(year)::int,
          'distinctProcedures', count(distinct cpt_code)::int,
          'snareShare', round(
            sum(case when snare_used = 'Yes' then total_volume::numeric else 0 end)
            / nullif(sum(total_volume::numeric), 0), 6))
        from public.bis_procedure_volumes where physician_npi = p_npi),
      'byYear', (
        select coalesce(jsonb_agg(jsonb_build_object('year', year, 'volume', volume) order by year), '[]'::jsonb)
        from (select year::int as year, sum(total_volume::numeric)::int as volume
              from public.bis_procedure_volumes where physician_npi = p_npi group by year) t),
      'byCategory', (
        select coalesce(jsonb_agg(jsonb_build_object('category', category, 'volume', volume) order by volume desc), '[]'::jsonb)
        from (select procedure_category as category, sum(total_volume::numeric)::int as volume
              from public.bis_procedure_volumes where physician_npi = p_npi group by procedure_category) t),
      'byPayer', (
        select coalesce(jsonb_agg(jsonb_build_object('payer', payer, 'volume', volume) order by volume desc), '[]'::jsonb)
        from (select payer_category as payer, sum(total_volume::numeric)::int as volume
              from public.bis_procedure_volumes where physician_npi = p_npi group by payer_category) t),
      'topProcedures', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'cptCode', "cptCode", 'description', description, 'volume', volume,
                 'medicarePhysicianRate', "medicarePhysicianRate", 'commercialRate', "commercialRate") order by volume desc), '[]'::jsonb)
        from (select pv.cpt_code as "cptCode", max(pv.procedure_description) as description,
                     sum(pv.total_volume::numeric)::int as volume,
                     max(r.medicare_physician_rate)::float8 as "medicarePhysicianRate",
                     max(r.commercial_benchmark_rate)::float8 as "commercialRate"
              from public.bis_procedure_volumes pv
              left join public.bis_cpt_reimbursement r on r.cpt_code = pv.cpt_code
              where pv.physician_npi = p_npi group by pv.cpt_code order by volume desc limit 8) t),
      'facilities', (
        select coalesce(jsonb_agg(jsonb_build_object('facilityId', "facilityId", 'volume', volume) order by volume desc), '[]'::jsonb)
        from (select facility_id as "facilityId", sum(total_volume::numeric)::int as volume
              from public.bis_procedure_volumes where physician_npi = p_npi group by facility_id order by volume desc limit 5) t)
    )
  end;
$$;

-- ── Function 3: ranked physician search (name/email/npi/specialty/facility) ──
create or replace function public.bis_search_physicians(p_query text, p_limit int default 20)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with input as (select trim(p_query) as q),
  scored as (
    select p.physician_npi, p.physician_name, p.specialty, p.email, p.phone,
           p.esd_procedure, p.photo_url, p.linkedin_url,
           f.facility_id, f.facility_name, f.facility_type, f.address, f.city, f.state, f.zip,
           greatest(
             case when p.email is not null and lower(p.email) = lower(i.q) then 100 else 0 end,
             case when p.physician_npi = i.q then 100 else 0 end,
             case when p.physician_name ilike i.q || '%' then 85 else 0 end,
             case when p.physician_name ilike '%' || i.q || '%' then 70 else 0 end,
             case when p.email ilike '%' || i.q || '%' then 65 else 0 end,
             case when f.facility_name ilike '%' || i.q || '%' then 55 else 0 end,
             case when f.city ilike i.q || '%' then 45 else 0 end,
             case when p.specialty ilike '%' || i.q || '%' then 40 else 0 end) as score
    from public.bis_physicians p
    left join public.bis_facilities f on f.facility_id = p.primary_facility_id
    cross join input i)
  select coalesce(jsonb_agg(jsonb_build_object(
    'npi', physician_npi, 'name', physician_name, 'specialty', specialty,
    'email', email, 'phone', phone, 'esdProcedure', esd_procedure,
    'photoUrl', photo_url, 'linkedinUrl', linkedin_url, 'score', score,
    'facility', case when facility_id is null then null else jsonb_build_object(
      'id', facility_id, 'name', facility_name, 'type', facility_type,
      'address', address, 'city', city, 'state', state, 'zip', zip) end
  ) order by has_email desc, score desc, physician_name), '[]'::jsonb)
  from (select *, (email is not null) as has_email from scored
        where score > 0 order by (email is not null) desc, score desc, physician_name
        limit p_limit) t;
$$;

-- ── Platform tables: CRM activities, ingested emails, append-only audit ─────
create table if not exists app_activities (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null, title text, physician_npi text, facility_id text,
  calendar_event_id text unique, thread_id text, status text default 'open',
  meeting_date date, created_at timestamptz default now(), updated_at timestamptz default now());
create index if not exists idx_app_activities_owner on app_activities (owner_user_id, meeting_date desc);
create index if not exists idx_app_activities_thread on app_activities (thread_id);
create index if not exists idx_app_activities_npi on app_activities (physician_npi);

create table if not exists app_emails (
  id uuid primary key default gen_random_uuid(),
  provider text not null, provider_msg_id text not null, internet_msg_id text,
  thread_id text, in_reply_to text, owner_user_id text not null,
  activity_id uuid references app_activities(id),
  from_email text, from_name text, to_emails text[], cc_emails text[],
  subject text, body_text text, body_raw text,
  received_at timestamptz, ingested_at timestamptz default now(),
  unique (provider, provider_msg_id));
create index if not exists idx_app_emails_thread on app_emails (thread_id);
create index if not exists idx_app_emails_owner on app_emails (owner_user_id, received_at desc);

create table if not exists app_audit_log (
  id bigint generated always as identity primary key, at timestamptz default now(),
  actor text not null, action text not null, entity_type text, entity_id text,
  source_email_id uuid, details jsonb);
create index if not exists idx_app_audit_at on app_audit_log (at desc);

alter table app_activities enable row level security;
alter table app_emails     enable row level security;
alter table app_audit_log  enable row level security;

-- Permissive anon/authenticated policies (POC posture; the server may instead
-- use the service-role key, which bypasses RLS). Drop-then-create = idempotent.
drop policy if exists "app_activities anon all" on app_activities;
create policy "app_activities anon all" on app_activities for all to anon, authenticated using (true) with check (true);
drop policy if exists "app_emails anon all" on app_emails;
create policy "app_emails anon all" on app_emails for all to anon, authenticated using (true) with check (true);
drop policy if exists "app_audit insert" on app_audit_log;
create policy "app_audit insert" on app_audit_log for insert to anon, authenticated with check (true);
drop policy if exists "app_audit select" on app_audit_log;
create policy "app_audit select" on app_audit_log for select to anon, authenticated using (true);
