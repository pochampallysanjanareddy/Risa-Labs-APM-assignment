-- Sponsor Growth Center — Supabase setup.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.

-- One table holds every change the team makes (deal stage updates, new deals,
-- qualification changes, activity, targets, campaign plans, tasks, settings, change log).
-- The original dataset is shipped with the website and never edited; these rows sit on top of it.
create table if not exists public.records (
  collection text not null check (collection in ('opp_history','opportunities','brands','qualification','interactions','targets','campaigns','plans','tasks','log','settings')),
  id         text not null check (char_length(id) between 1 and 80),
  data       jsonb not null check (pg_column_size(data) < 20000),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

alter table public.records enable row level security;

-- Newer Supabase projects don't grant table access to the public (anon) role automatically.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.records to anon, authenticated;

-- Demo access: anyone with the link can read and add/change records; only tasks can be deleted.
-- (See README → Known limitations: there is no login, so this is not for real customer data.)
drop policy if exists "read all" on public.records;
drop policy if exists "insert" on public.records;
drop policy if exists "update" on public.records;
drop policy if exists "delete tasks" on public.records;
create policy "read all"     on public.records for select using (true);
create policy "insert"       on public.records for insert with check (true);
create policy "update"       on public.records for update using (true) with check (true);
create policy "delete tasks" on public.records for delete using (collection = 'tasks');

-- Live updates between open browsers (optional but nice)
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when others then null; end $$;

-- Starter data: campaign plans (budgets are SIMULATED — the source data has no sponsor spend) and three tasks.
insert into public.records (collection, id, data) values
 ('plans','SC01','{"status":"active","owner":"Kabir Shah","budget_inr":15000,"spent_inr":15000,"bet":"B5","group":"cold","notes":"Email tool licence (simulated)","simulated":true}'),
 ('plans','SC02','{"status":"active","owner":"Riya Kapoor","budget_inr":5000,"spent_inr":5000,"bet":"B1","group":"warm","notes":"Alumni meet-ups (simulated)","simulated":true}'),
 ('plans','SC03','{"status":"active","owner":"Riya Kapoor","budget_inr":25000,"spent_inr":25000,"bet":"B5","group":"cold","notes":"LinkedIn Sales Navigator (simulated)","simulated":true}'),
 ('plans','SC04','{"status":"active","owner":"Kabir Shah","budget_inr":30000,"spent_inr":30000,"bet":"B3","group":"warm","notes":"Sponsor page and promotion (simulated)","simulated":true}'),
 ('plans','SC05','{"status":"active","owner":"Nisha Rao","budget_inr":80000,"spent_inr":78500,"bet":"B2","group":"warm","notes":"10% finder''s fees on signed referrals (simulated)","simulated":true}'),
 ('plans','SC06','{"status":"active","owner":"Kabir Shah","budget_inr":5000,"spent_inr":5000,"bet":"B5","group":"cold","notes":"Email tool share (simulated)","simulated":true}'),
 ('tasks','TKSEED1','{"id":"TKSEED1","title":"Send proposals to the 18 qualified brands with no deal","owner":"Riya Kapoor","due":"2026-11-28","priority":"high","status":"todo","campaign_id":"","bet":"B1","opportunity_id":"","reason":"12 of them came from warm or inbound channels, which won 24 of 25 deals last year.","source":"seed","created_at":"2026-11-25T09:46:00Z"}'),
 ('tasks','TKSEED2','{"id":"TKSEED2","title":"Close or revive the 26 stale cold-channel deals","owner":"Kabir Shah","due":"2026-11-30","priority":"medium","status":"todo","campaign_id":"","bet":"B5","opportunity_id":"","reason":"₹14.4L sits in deals untouched for 14+ days; cold campaigns won 0 of 33.","source":"seed","created_at":"2026-11-25T09:46:00Z"}'),
 ('tasks','TKSEED3','{"id":"TKSEED3","title":"Recruit 5 Hyderabad creators and clubs as referrers","owner":"Nisha Rao","due":"2026-12-02","priority":"medium","status":"doing","campaign_id":"SC05","bet":"B2","opportunity_id":"","reason":"Pilot for bet B2; referrals won 9 of 9 last year.","source":"seed","created_at":"2026-11-25T09:46:00Z"}')
on conflict (collection, id) do nothing;

-- To reset everything back to the original dataset:  delete from public.records;  (then re-run the insert above)
