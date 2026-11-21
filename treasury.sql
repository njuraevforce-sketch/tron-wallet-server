begin;

create table if not exists public.treasury_lanes (
  chain text primary key check (chain in ('ethereum','bsc','opbnb','tron')),
  revision bigint not null default 0,
  worker uuid,
  lease_until timestamptz,
  cursor_state jsonb not null default '{}',
  pending jsonb,
  hold_reason text,
  budget_day date,
  reserved_fee numeric(78,0) not null default 0
);
create table if not exists public.treasury_transfers (
  chain text not null,
  tx_hash text not null,
  details jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (chain, tx_hash)
);
create table if not exists public.treasury_requests (
  id bigint generated always as identity primary key,
  chain text not null,
  user_id uuid not null,
  deposit_id text not null unique
);
create index if not exists treasury_requests_chain_id on public.treasury_requests(chain,id);
alter table public.treasury_requests enable row level security;
revoke all on public.treasury_requests from public,anon,authenticated;
grant select,delete on public.treasury_requests to service_role;
create or replace function public.treasury_after_credit() returns trigger
language plpgsql security definer set search_path='' as $$
declare network_chain text;
begin
  if new.status::text not in ('credited','completed') then return new; end if;
  network_chain := case new.network::text when 'usdt_erc20' then 'ethereum'
    when 'usdc_erc20' then 'ethereum' when 'usdt_bep20' then 'bsc'
    when 'usdc_bep20' then 'bsc' when 'usdt_trc20' then 'tron' end;
  if network_chain is not null and new.user_id is not null then
    insert into public.treasury_requests(chain,user_id,deposit_id) values(network_chain,new.user_id,new.id::text)
      on conflict(deposit_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.treasury_after_credit() from public,anon,authenticated;
create or replace trigger treasury_notify_credit after insert or update of status on public.deposits
for each row execute function public.treasury_after_credit();
alter table public.treasury_lanes enable row level security;
alter table public.treasury_transfers enable row level security;
revoke all on public.treasury_lanes, public.treasury_transfers from public, anon, authenticated;
grant select,insert,update on public.treasury_lanes to service_role;
grant select,insert on public.treasury_transfers to service_role;
insert into public.treasury_lanes(chain) values ('ethereum'),('bsc'),('opbnb'),('tron')
on conflict do nothing;

create or replace function public.treasury_claim(p_chain text,p_worker uuid)
returns setof public.treasury_lanes language sql security invoker set search_path='' as $$
  update public.treasury_lanes set worker=p_worker, lease_until=clock_timestamp()+interval '90 seconds',
    revision=revision+1
  where chain=p_chain and hold_reason is null and (lease_until is null or lease_until<clock_timestamp())
  returning *;
$$;

create or replace function public.treasury_advance(
  p_chain text,p_worker uuid,p_revision bigint,p_cursor jsonb,p_pending jsonb,
  p_fee text,p_daily_cap text,p_event jsonb,p_hold text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  today date := (clock_timestamp() at time zone 'UTC')::date;
  lane public.treasury_lanes;
  fee numeric;
  cap numeric;
begin
  if p_fee !~ '^[0-9]{1,78}$' or p_daily_cap !~ '^[0-9]{1,78}$' then
    raise exception 'INVALID_FEE';
  end if;
  fee := p_fee::numeric;
  cap := p_daily_cap::numeric;
  select * into lane from public.treasury_lanes where chain=p_chain and worker=p_worker
    and revision=p_revision and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if lane.budget_day is distinct from today then lane.reserved_fee := 0; end if;
  if fee>0 and lane.reserved_fee+fee>cap then raise exception 'DAILY_FEE_CAP'; end if;
  if p_event is not null then
    insert into public.treasury_transfers(chain,tx_hash,details) values(p_chain,p_event->>'hash',p_event)
    on conflict do nothing;
  end if;
  if p_cursor ? 'ack' then
    delete from public.treasury_requests where chain=p_chain and id=(p_cursor->>'ack')::bigint;
  end if;
  update public.treasury_lanes set cursor_state=p_cursor-'ack', pending=p_pending, hold_reason=p_hold,
    budget_day=today,reserved_fee=lane.reserved_fee+fee, revision=revision+1,
    worker=null,lease_until=null where chain=p_chain;
  return true;
end $$;
revoke all on function public.treasury_claim(text,uuid) from public,anon,authenticated;
revoke all on function public.treasury_advance(text,uuid,bigint,jsonb,jsonb,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.treasury_claim(text,uuid) to service_role;
grant execute on function public.treasury_advance(text,uuid,bigint,jsonb,jsonb,text,text,jsonb,text)
  to service_role;
commit;
