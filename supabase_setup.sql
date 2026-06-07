-- ───────────────────────────────────────────────────────────────
-- Revyy — run this once in the Supabase SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run)
-- Creates the per-user profile table that stores Pro status.
-- ───────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  is_pro             boolean not null default false,
  stripe_customer_id text,
  created_at         timestamptz not null default now()
);

-- If the table already existed, make sure all payment columns are present:
alter table public.profiles add column if not exists is_pro              boolean default false;
alter table public.profiles add column if not exists stripe_customer_id  text;
alter table public.profiles add column if not exists subscription_id     text;
alter table public.profiles add column if not exists subscription_status text;
alter table public.profiles add column if not exists trial_end           timestamp;
alter table public.profiles add column if not exists subscription_plan   text;        -- 'monthly' | 'yearly'
alter table public.profiles add column if not exists current_period_end  timestamp;   -- next billing date
alter table public.profiles add column if not exists cancel_at_period_end boolean default false;

alter table public.profiles enable row level security;

-- Each user may read their own profile
create policy "Profiles are viewable by owner"
  on public.profiles for select
  using (auth.uid() = id);

-- Each user may create their own profile row
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Each user may update their own profile (e.g. upgrade to Pro)
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up
-- (covers both email/password and Google sign-ups).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, is_pro)
  values (new.id, false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
