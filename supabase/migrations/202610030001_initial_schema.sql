create extension if not exists pgcrypto;

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New Conversation',
  created_at timestamptz not null default now(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade
);

create table if not exists public.agent_goals (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  goal_title text not null,
  status text not null default 'in_progress' check (status in ('planning', 'in_progress', 'completed', 'failed')),
  steps jsonb not null default '[]'::jsonb,
  browser_session_id text,
  created_at timestamptz not null default now(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade
);

create table if not exists public.execution_traces (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_goal_id uuid references public.agent_goals(id) on delete set null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in ('browser_use', 'base44', 'playwright', 'evaluator', 'offline')),
  event text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversations_owner_created_idx on public.conversations(owner_id, created_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists goals_owner_session_idx on public.agent_goals(owner_id, browser_session_id);
create index if not exists traces_conversation_created_idx on public.execution_traces(conversation_id, created_at desc);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_goals enable row level security;
alter table public.execution_traces enable row level security;

create policy "Users manage their conversations"
  on public.conversations for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "Users manage their messages"
  on public.messages for all to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())
  ))
  with check (owner_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())
  ));

create policy "Users manage their goals"
  on public.agent_goals for all to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())
  ))
  with check (owner_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())
  ));

create policy "Users read their execution traces"
  on public.execution_traces for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid())
  ));

grant select, insert, update, delete on public.conversations, public.messages, public.agent_goals to authenticated;
grant select on public.execution_traces to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-attachments', 'agent-attachments', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

create policy "Users upload their own agent attachments"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'agent-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users read their own agent attachments"
  on storage.objects for select to authenticated
  using (bucket_id = 'agent-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users delete their own agent attachments"
  on storage.objects for delete to authenticated
  using (bucket_id = 'agent-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$
begin
  alter publication supabase_realtime add table public.conversations;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.execution_traces;
exception when duplicate_object then null;
end $$;
