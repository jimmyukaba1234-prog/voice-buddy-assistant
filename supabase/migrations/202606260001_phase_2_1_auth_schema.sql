-- Phase 2.1: Supabase Auth + database schema foundation.
-- Review this file before running it in Supabase SQL Editor.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'name')
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  source_message_id uuid references public.messages(id) on delete set null,
  confidence numeric(4, 3) not null default 1.000 check (confidence >= 0 and confidence <= 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  notes text,
  due_at timestamptz not null,
  timezone text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text,
  location text,
  status text not null default 'confirmed' check (status in ('tentative', 'confirmed', 'cancelled')),
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

create table if not exists public.news_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  topics text[] not null default '{}'::text[],
  sources text[] not null default '{}'::text[],
  excluded_sources text[] not null default '{}'::text[],
  region text default 'US',
  language text default 'en',
  frequency text not null default 'daily' check (frequency in ('realtime', 'daily', 'weekly')),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tool_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  tool_name text not null,
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists conversations_user_id_created_at_idx
  on public.conversations (user_id, created_at desc);
create index if not exists messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at);
create index if not exists messages_user_id_created_at_idx
  on public.messages (user_id, created_at desc);
create index if not exists memories_user_id_updated_at_idx
  on public.memories (user_id, updated_at desc);
create index if not exists reminders_user_id_due_at_idx
  on public.reminders (user_id, due_at);
create index if not exists calendar_events_user_id_starts_at_idx
  on public.calendar_events (user_id, starts_at);
create index if not exists tool_runs_user_id_created_at_idx
  on public.tool_runs (user_id, created_at desc);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_conversations_updated_at on public.conversations;
create trigger set_conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

drop trigger if exists set_memories_updated_at on public.memories;
create trigger set_memories_updated_at
  before update on public.memories
  for each row execute function public.set_updated_at();

drop trigger if exists set_reminders_updated_at on public.reminders;
create trigger set_reminders_updated_at
  before update on public.reminders
  for each row execute function public.set_updated_at();

drop trigger if exists set_calendar_events_updated_at on public.calendar_events;
create trigger set_calendar_events_updated_at
  before update on public.calendar_events
  for each row execute function public.set_updated_at();

drop trigger if exists set_news_preferences_updated_at on public.news_preferences;
create trigger set_news_preferences_updated_at
  before update on public.news_preferences
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.reminders enable row level security;
alter table public.calendar_events enable row level security;
alter table public.news_preferences enable row level security;
alter table public.tool_runs enable row level security;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using (id = auth.uid());

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (id = auth.uid());

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "Users can delete own profile" on public.profiles;
create policy "Users can delete own profile"
  on public.profiles for delete
  using (id = auth.uid());

drop policy if exists "Users can view own conversations" on public.conversations;
create policy "Users can view own conversations"
  on public.conversations for select
  using (user_id = auth.uid());

drop policy if exists "Users can insert own conversations" on public.conversations;
create policy "Users can insert own conversations"
  on public.conversations for insert
  with check (user_id = auth.uid());

drop policy if exists "Users can update own conversations" on public.conversations;
create policy "Users can update own conversations"
  on public.conversations for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own conversations" on public.conversations;
create policy "Users can delete own conversations"
  on public.conversations for delete
  using (user_id = auth.uid());

drop policy if exists "Users can view own messages" on public.messages;
create policy "Users can view own messages"
  on public.messages for select
  using (user_id = auth.uid());

drop policy if exists "Users can insert own messages" on public.messages;
create policy "Users can insert own messages"
  on public.messages for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.conversations
      where conversations.id = messages.conversation_id
        and conversations.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages"
  on public.messages for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own messages" on public.messages;
create policy "Users can delete own messages"
  on public.messages for delete
  using (user_id = auth.uid());

drop policy if exists "Users can manage own memories" on public.memories;
create policy "Users can manage own memories"
  on public.memories for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can manage own reminders" on public.reminders;
create policy "Users can manage own reminders"
  on public.reminders for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can manage own calendar events" on public.calendar_events;
create policy "Users can manage own calendar events"
  on public.calendar_events for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can manage own news preferences" on public.news_preferences;
create policy "Users can manage own news preferences"
  on public.news_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can manage own tool runs" on public.tool_runs;
create policy "Users can manage own tool runs"
  on public.tool_runs for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
