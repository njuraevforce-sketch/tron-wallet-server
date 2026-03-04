-- Oracle / Quantification platform schema (Supabase Postgres)
-- Business day rolls over at 19:00 UTC.

-- ========= Extensions =========
create extension if not exists pgcrypto;

-- ========= Sequences =========
create sequence if not exists public.public_id_seq;

-- ========= Helpers =========
create or replace function public.business_day(p_ts timestamptz)
returns date
language sql
stable
as $$
  select ((p_ts at time zone 'UTC') - interval '19 hours')::date;
$$;

create or replace function public.current_business_day()
returns date
language sql
stable
as $$
  select public.business_day(now());
$$;

-- ========= Admins =========
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

create or replace function public.is_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (select 1 from public.app_admins a where a.user_id = p_uid);
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- ========= Core user tables =========
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_id bigint not null default nextval('public.public_id_seq') unique,
  email text,
  username text,
  invite_code text unique,
  referrer_id uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_accounts (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  main_balance numeric(18,2) not null default 0,
  bonus_balance numeric(18,2) not null default 0,
  bonus_expires_at timestamptz,
  tickets int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  kind text not null,
  amount numeric(18,2) not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_user_idx on public.wallet_ledger(user_id, created_at desc);

-- ========= Referral (3 generations) =========
create table if not exists public.referral_edges (
  child_id uuid primary key references public.profiles(user_id) on delete cascade,
  parent_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint referral_no_self check (child_id <> parent_id)
);

create table if not exists public.referral_closure (
  ancestor_id uuid not null references public.profiles(user_id) on delete cascade,
  descendant_id uuid not null references public.profiles(user_id) on delete cascade,
  depth smallint not null check (depth between 1 and 3),
  created_at timestamptz not null default now(),
  primary key (ancestor_id, descendant_id)
);

create index if not exists referral_closure_ancestor_idx on public.referral_closure(ancestor_id, depth);
create index if not exists referral_closure_descendant_idx on public.referral_closure(descendant_id, depth);

-- ========= Wallets for deposits =========
create table if not exists public.user_wallets (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  usdt_bep20_address text,
  usdc_bep20_address text,
  usdt_erc20_address text,
  usdc_erc20_address text,
  default_network text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.private_keys (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  network text not null,
  address text not null,
  encrypted_private_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, network)
);

-- ========= Deposits =========
create table if not exists public.deposit_requests (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  token text not null check (token in ('USDT','USDC')),
  network text not null check (network in ('usdt_bep20','usdc_bep20','usdt_erc20','usdc_erc20')),
  amount numeric(18,2) not null check (amount > 0),
  tx_hash text not null,
  status text not null default 'completed' check (status in ('pending','completed','failed')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  unique (tx_hash, network)
);

create index if not exists deposit_requests_user_idx on public.deposit_requests(user_id, created_at desc);

-- ========= Withdraw addresses (locked) =========
create table if not exists public.withdrawal_addresses (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  token text not null check (token in ('USDT','USDC')),
  network text not null check (network in ('bep20','erc20')),
  address text not null,
  is_locked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token, network)
);

-- ========= Verification =========
create table if not exists public.user_verifications (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  messenger_type text not null check (messenger_type in ('telegram','whatsapp')),
  messenger_contact text not null,
  document_type text not null check (document_type in ('id','passport','driver')),
  document_number text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  note text
);

-- ========= Grid tiers =========
create table if not exists public.grid_tiers (
  grid_code text primary key,
  daily_rate numeric(8,4) not null check (daily_rate > 0),
  min_self_balance numeric(18,2) not null default 0,
  max_self_balance numeric(18,2),
  min_gen1_count int not null default 0,
  min_gen1_deposit numeric(18,2) not null default 0,
  sort_order int not null
);

-- Seed tiers (you can edit later in admin)
insert into public.grid_tiers (grid_code, daily_rate, min_self_balance, max_self_balance, min_gen1_count, min_gen1_deposit, sort_order)
values
  ('GRID1', 0.0240, 30, 300, 0,   0,   1),
  ('GRID2', 0.0300, 30, null, 3,  30,  2),
  ('GRID3', 0.0360, 30, null, 5,  50,  3),
  ('GRID4', 0.0400, 30, null, 5, 100,  4),
  ('GRID5', 0.0460, 30, null, 10,150,  5),
  ('GRID6', 0.0500, 30, null, 15,300,  6)
on conflict (grid_code) do update set
  daily_rate = excluded.daily_rate,
  min_self_balance = excluded.min_self_balance,
  max_self_balance = excluded.max_self_balance,
  min_gen1_count = excluded.min_gen1_count,
  min_gen1_deposit = excluded.min_gen1_deposit,
  sort_order = excluded.sort_order;

-- ========= Quantification: signals + earnings =========
create table if not exists public.quant_signals (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  biz_date date not null,
  signal_no smallint not null check (signal_no between 1 and 3),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, biz_date, signal_no)
);

create table if not exists public.quant_earnings (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  biz_date date not null,
  grid_code text not null,
  rate numeric(8,4) not null,
  base_amount numeric(18,2) not null,
  amount numeric(18,2) not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz not null default now(),
  primary key (user_id, biz_date)
);

create table if not exists public.referral_earnings (
  id bigserial primary key,
  referrer_id uuid not null references public.profiles(user_id) on delete cascade,
  from_user_id uuid not null references public.profiles(user_id) on delete cascade,
  biz_date date not null,
  depth smallint not null check (depth between 1 and 3),
  percent numeric(6,4) not null,
  amount numeric(18,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists referral_earnings_referrer_idx on public.referral_earnings(referrer_id, created_at desc);

-- ========= Scratch tickets =========
create table if not exists public.scratch_ticket_events (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  delta int not null,
  reason text not null,
  deposit_id bigint references public.deposit_requests(id) on delete set null,
  source_user_id uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists scratch_ticket_events_user_idx on public.scratch_ticket_events(user_id, created_at desc);

create table if not exists public.scratch_rewards (
  reward_amount numeric(18,2) primary key,
  weight int not null default 1 check (weight > 0)
);

insert into public.scratch_rewards (reward_amount, weight)
values
  (1.50, 50),
  (3.00, 30),
  (5.00, 15),
  (20.00, 4),
  (50.00, 1),
  (200.00, 1)
on conflict (reward_amount) do nothing;

create table if not exists public.scratch_events (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  card_index int not null check (card_index between 1 and 6),
  reward_amount numeric(18,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists scratch_events_user_idx on public.scratch_events(user_id, created_at desc);

-- ========= Utility: invite codes =========
create or replace function public.make_invite_code()
returns text
language sql
volatile
as $$
  select upper(substr(encode(gen_random_bytes(16), 'hex'), 1, 10));
$$;

-- ========= Bonus expiry =========
create or replace function public.expire_bonus_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_bonus numeric(18,2);
  v_expires timestamptz;
begin
  select bonus_balance, bonus_expires_at
    into v_bonus, v_expires
  from public.user_accounts
  where user_id = p_user_id
  for update;

  if v_bonus is null then
    return;
  end if;

  if v_bonus > 0 and v_expires is not null and now() >= v_expires then
    update public.user_accounts
      set bonus_balance = 0,
          updated_at = now()
    where user_id = p_user_id;

    insert into public.wallet_ledger(user_id, kind, amount, meta)
    values (p_user_id, 'bonus_expire', -v_bonus, jsonb_build_object('expires_at', v_expires));
  end if;
end;
$$;

grant execute on function public.expire_bonus_for_user(uuid) to authenticated;

-- ========= Tickets awarding =========
create or replace function public._tickets_for_personal_deposit(p_amount numeric)
returns int
language sql
stable
as $$
  select case
    when p_amount >= 500 then 10
    when p_amount >= 200 then 5
    when p_amount >= 100 then 2
    when p_amount >= 30  then 1
    else 0
  end;
$$;

create or replace function public._tickets_for_gen1_deposit(p_amount numeric)
returns int
language sql
stable
as $$
  select case
    when p_amount >= 300 then 5
    when p_amount >= 100 then 2
    when p_amount >= 50  then 1
    else 0
  end;
$$;

create or replace function public._add_tickets(
  p_user_id uuid,
  p_delta int,
  p_reason text,
  p_deposit_id bigint default null,
  p_source_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_delta = 0 then
    return;
  end if;

  update public.user_accounts
    set tickets = tickets + p_delta,
        updated_at = now()
  where user_id = p_user_id;

  insert into public.scratch_ticket_events(user_id, delta, reason, deposit_id, source_user_id)
  values (p_user_id, p_delta, p_reason, p_deposit_id, p_source_user_id);
end;
$$;

-- ========= Deposit atomic RPC (used by server.js) =========
create or replace function public.create_deposit_with_balance(
  p_user_id uuid,
  p_amount numeric,
  p_network text,
  p_tx_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_token text;
  v_deposit_id bigint;
  v_old numeric(18,2);
  v_new numeric(18,2);
  v_personal_tickets int;
  v_parent uuid;
  v_parent_tickets int;
begin
  if p_network not in ('usdt_bep20','usdc_bep20','usdt_erc20','usdc_erc20') then
    return jsonb_build_object('success', false, 'error', 'Unsupported network');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Invalid amount');
  end if;

  v_token := case when p_network like 'usdt_%' then 'USDT' else 'USDC' end;

  -- Insert deposit row
  insert into public.deposit_requests(user_id, token, network, amount, tx_hash, status, approved_at)
  values (p_user_id, v_token, p_network, round(p_amount::numeric,2), p_tx_hash, 'completed', now())
  on conflict (tx_hash, network) do nothing
  returning id into v_deposit_id;

  if v_deposit_id is null then
    select id into v_deposit_id
    from public.deposit_requests
    where tx_hash = p_tx_hash and network = p_network
    limit 1;

    return jsonb_build_object('success', true, 'already_processed', true, 'deposit_id', v_deposit_id);
  end if;

  -- Expire bonus if needed
  perform public.expire_bonus_for_user(p_user_id);

  -- Update balance atomically
  select main_balance into v_old
  from public.user_accounts
  where user_id = p_user_id
  for update;

  if v_old is null then
    return jsonb_build_object('success', false, 'error', 'Account not found');
  end if;

  v_new := v_old + round(p_amount::numeric,2);

  update public.user_accounts
    set main_balance = v_new,
        updated_at = now()
  where user_id = p_user_id;

  insert into public.wallet_ledger(user_id, kind, amount, meta)
  values (p_user_id, 'deposit', round(p_amount::numeric,2), jsonb_build_object('deposit_id', v_deposit_id, 'network', p_network, 'tx_hash', p_tx_hash));

  -- Task center: personal deposit tickets
  v_personal_tickets := public._tickets_for_personal_deposit(p_amount);
  perform public._add_tickets(p_user_id, v_personal_tickets, 'personal_deposit', v_deposit_id, null);

  -- Task center: upline (generation 1) gets tickets from gen1 deposits
  select referrer_id into v_parent from public.profiles where user_id = p_user_id;
  if v_parent is not null then
    v_parent_tickets := public._tickets_for_gen1_deposit(p_amount);
    perform public._add_tickets(v_parent, v_parent_tickets, 'gen1_deposit', v_deposit_id, p_user_id);
  end if;

  return jsonb_build_object(
    'success', true,
    'deposit_id', v_deposit_id,
    'old_balance', v_old,
    'new_balance', v_new
  );
end;
$$;

grant execute on function public.create_deposit_with_balance(uuid,numeric,text,text) to authenticated;

-- ========= Compute user grid =========
create or replace function public.compute_user_grid(p_user_id uuid)
returns table(grid_code text, rate numeric)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_balance numeric(18,2);
  v_direct_count int;
begin
  perform public.expire_bonus_for_user(p_user_id);

  select main_balance into v_balance
  from public.user_accounts
  where user_id = p_user_id;

  if v_balance is null then
    return;
  end if;

  for grid_code, rate in
    select t.grid_code, t.daily_rate
    from public.grid_tiers t
    where v_balance >= t.min_self_balance
      and (t.max_self_balance is null or v_balance <= t.max_self_balance)
      and (
        t.min_gen1_count = 0
        or (
          select count(*)
          from public.profiles r
          where r.referrer_id = p_user_id
            and (
              select coalesce(sum(d.amount),0)
              from public.deposit_requests d
              where d.user_id = r.user_id and d.status = 'completed'
            ) >= t.min_gen1_deposit
        ) >= t.min_gen1_count
      )
    order by t.sort_order desc
  loop
    return next;
    exit;
  end loop;
end;
$$;

grant execute on function public.compute_user_grid(uuid) to authenticated;

-- ========= Signals =========
create or replace function public.ensure_daily_signals(p_user_id uuid, p_biz_date date)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  i int;
  v_side text;
  v_symbol text;
begin
  for i in 1..3 loop
    if not exists (
      select 1 from public.quant_signals s
      where s.user_id = p_user_id and s.biz_date = p_biz_date and s.signal_no = i
    ) then
      v_side := case when random() < 0.5 then 'BUY' else 'SELL' end;
      v_symbol := (array['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','DOGE/USDT'])[1+floor(random()*6)];
      insert into public.quant_signals(user_id, biz_date, signal_no, payload)
      values (p_user_id, p_biz_date, i, jsonb_build_object('side', v_side, 'symbol', v_symbol, 'note', 'Quant signal'))
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

grant execute on function public.ensure_daily_signals(uuid,date) to authenticated;

-- ========= Claim daily income =========
create or replace function public.claim_daily_income()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_biz date;
  v_grid text;
  v_rate numeric;
  v_base numeric(18,2);
  v_amount numeric(18,2);
  v_row record;
  v_paid int := 0;
  v_percent numeric;
  v_ref_amount numeric(18,2);
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  v_biz := public.current_business_day();

  -- Only once per business day
  if exists (select 1 from public.quant_earnings e where e.user_id = v_uid and e.biz_date = v_biz) then
    return jsonb_build_object('success', false, 'error', 'Already claimed for this business day', 'biz_date', v_biz);
  end if;

  perform public.ensure_daily_signals(v_uid, v_biz);

  select grid_code, rate into v_grid, v_rate
  from public.compute_user_grid(v_uid)
  limit 1;

  if v_grid is null then
    return jsonb_build_object('success', false, 'error', 'Not eligible for GRID yet');
  end if;

  -- Expire bonus before calculation
  perform public.expire_bonus_for_user(v_uid);

  select main_balance into v_base
  from public.user_accounts
  where user_id = v_uid
  for update;

  if v_base is null then
    return jsonb_build_object('success', false, 'error', 'Account not found');
  end if;

  v_amount := round(v_base * v_rate, 2);

  update public.user_accounts
    set main_balance = main_balance + v_amount,
        updated_at = now()
  where user_id = v_uid;

  insert into public.quant_earnings(user_id, biz_date, grid_code, rate, base_amount, amount)
  values (v_uid, v_biz, v_grid, v_rate, v_base, v_amount);

  insert into public.wallet_ledger(user_id, kind, amount, meta)
  values (v_uid, 'quant_income', v_amount, jsonb_build_object('biz_date', v_biz, 'grid', v_grid, 'rate', v_rate));

  -- Pay upline: 10% / 5% / 3% from the user's daily income
  for v_row in
    select ancestor_id, depth
    from public.referral_closure
    where descendant_id = v_uid
    order by ancestor_id
  loop
    v_percent := case v_row.depth
      when 1 then 0.10
      when 2 then 0.05
      when 3 then 0.03
      else 0
    end;

    v_ref_amount := round(v_amount * v_percent, 2);
    if v_ref_amount <= 0 then
      continue;
    end if;

    update public.user_accounts
      set main_balance = main_balance + v_ref_amount,
          updated_at = now()
    where user_id = v_row.ancestor_id;

    insert into public.referral_earnings(referrer_id, from_user_id, biz_date, depth, percent, amount)
    values (v_row.ancestor_id, v_uid, v_biz, v_row.depth, v_percent, v_ref_amount);

    insert into public.wallet_ledger(user_id, kind, amount, meta)
    values (v_row.ancestor_id, 'referral_income', v_ref_amount,
      jsonb_build_object('from_user_id', v_uid, 'biz_date', v_biz, 'depth', v_row.depth, 'percent', v_percent)
    );

    v_paid := v_paid + 1;
  end loop;

  return jsonb_build_object(
    'success', true,
    'biz_date', v_biz,
    'grid', v_grid,
    'rate', v_rate,
    'base_amount', v_base,
    'amount', v_amount,
    'upline_paid', v_paid
  );
end;
$$;

grant execute on function public.claim_daily_income() to authenticated;

-- ========= Scratch redeem =========
create or replace function public.scratch_redeem(p_card_index int)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_tickets int;
  v_total_weight int;
  v_roll int;
  v_running int := 0;
  v_reward numeric(18,2);
  v_row record;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  if p_card_index is null or p_card_index < 1 or p_card_index > 6 then
    return jsonb_build_object('success', false, 'error', 'Invalid card index');
  end if;

  perform public.expire_bonus_for_user(v_uid);

  select tickets into v_tickets
  from public.user_accounts
  where user_id = v_uid
  for update;

  if v_tickets is null then
    return jsonb_build_object('success', false, 'error', 'Account not found');
  end if;

  if v_tickets <= 0 then
    return jsonb_build_object('success', false, 'error', 'No tickets');
  end if;

  select sum(weight)::int into v_total_weight from public.scratch_rewards;
  if v_total_weight is null or v_total_weight <= 0 then
    return jsonb_build_object('success', false, 'error', 'Rewards not configured');
  end if;

  v_roll := floor(random() * v_total_weight)::int + 1;

  for v_row in select reward_amount, weight from public.scratch_rewards order by reward_amount asc loop
    v_running := v_running + v_row.weight;
    if v_roll <= v_running then
      v_reward := v_row.reward_amount;
      exit;
    end if;
  end loop;

  if v_reward is null then
    v_reward := 1.50;
  end if;

  -- consume ticket
  update public.user_accounts
    set tickets = tickets - 1,
        main_balance = main_balance + v_reward,
        updated_at = now()
  where user_id = v_uid;

  insert into public.scratch_events(user_id, card_index, reward_amount)
  values (v_uid, p_card_index, v_reward);

  insert into public.wallet_ledger(user_id, kind, amount, meta)
  values (v_uid, 'scratch_bonus', v_reward, jsonb_build_object('card_index', p_card_index));

  return jsonb_build_object('success', true, 'reward', v_reward, 'card_index', p_card_index);
end;
$$;

grant execute on function public.scratch_redeem(int) to authenticated;

-- ========= Withdrawal address: set once =========
create or replace function public.set_withdrawal_address_once(
  p_token text,
  p_network text,
  p_address text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_exists boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  if p_token not in ('USDT','USDC') then
    return jsonb_build_object('success', false, 'error', 'Invalid token');
  end if;

  if p_network not in ('bep20','erc20') then
    return jsonb_build_object('success', false, 'error', 'Invalid network');
  end if;

  if p_address is null or length(trim(p_address)) < 10 then
    return jsonb_build_object('success', false, 'error', 'Invalid address');
  end if;

  select exists(
    select 1 from public.withdrawal_addresses
    where user_id = v_uid and token = p_token and network = p_network
  ) into v_exists;

  if v_exists then
    return jsonb_build_object('success', false, 'error', 'Address already set. Contact admin to change.');
  end if;

  insert into public.withdrawal_addresses(user_id, token, network, address, is_locked)
  values (v_uid, p_token, p_network, trim(p_address), true);

  return jsonb_build_object('success', true);
end;
$$;

grant execute on function public.set_withdrawal_address_once(text,text,text) to authenticated;

-- ========= Verification submit =========
create or replace function public.submit_verification(
  p_messenger_type text,
  p_messenger_contact text,
  p_document_type text,
  p_document_number text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_status text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  if p_messenger_type not in ('telegram','whatsapp') then
    return jsonb_build_object('success', false, 'error', 'Invalid messenger type');
  end if;

  if p_document_type not in ('id','passport','driver') then
    return jsonb_build_object('success', false, 'error', 'Invalid document type');
  end if;

  if p_messenger_contact is null or length(trim(p_messenger_contact)) < 3 then
    return jsonb_build_object('success', false, 'error', 'Invalid contact');
  end if;

  if p_document_number is null or length(trim(p_document_number)) < 3 then
    return jsonb_build_object('success', false, 'error', 'Invalid document number');
  end if;

  select status into v_status from public.user_verifications where user_id = v_uid;
  if v_status = 'approved' then
    return jsonb_build_object('success', false, 'error', 'Already approved');
  end if;

  insert into public.user_verifications(user_id, messenger_type, messenger_contact, document_type, document_number, status, submitted_at)
  values (v_uid, p_messenger_type, trim(p_messenger_contact), p_document_type, trim(p_document_number), 'pending', now())
  on conflict (user_id) do update set
    messenger_type = excluded.messenger_type,
    messenger_contact = excluded.messenger_contact,
    document_type = excluded.document_type,
    document_number = excluded.document_number,
    status = 'pending',
    submitted_at = now(),
    reviewed_at = null,
    reviewed_by = null,
    note = null;

  return jsonb_build_object('success', true);
end;
$$;

grant execute on function public.submit_verification(text,text,text,text) to authenticated;

-- ========= Dashboard RPC =========
create or replace function public.get_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_prof record;
  v_acc record;
  v_grid record;
  v_biz date;
  v_claimed boolean;
  v_deposits numeric(18,2);
  v_ref_income_today numeric(18,2);
  v_income_today numeric(18,2);
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  perform public.expire_bonus_for_user(v_uid);

  select * into v_prof from public.profiles where user_id = v_uid;
  select * into v_acc from public.user_accounts where user_id = v_uid;

  v_biz := public.current_business_day();

  select exists(select 1 from public.quant_earnings e where e.user_id=v_uid and e.biz_date=v_biz) into v_claimed;

  select coalesce(sum(amount),0)::numeric(18,2) into v_deposits
  from public.deposit_requests d
  where d.user_id=v_uid and d.status='completed';

  select coalesce(sum(amount),0)::numeric(18,2) into v_ref_income_today
  from public.referral_earnings r
  where r.referrer_id=v_uid and r.biz_date=v_biz;

  select coalesce(amount,0)::numeric(18,2) into v_income_today
  from public.quant_earnings e
  where e.user_id=v_uid and e.biz_date=v_biz;

  select * into v_grid from public.compute_user_grid(v_uid);

  return jsonb_build_object(
    'success', true,
    'biz_date', v_biz,
    'profile', jsonb_build_object(
      'user_id', v_prof.user_id,
      'public_id', v_prof.public_id,
      'email', v_prof.email,
      'username', v_prof.username,
      'invite_code', v_prof.invite_code,
      'referrer_id', v_prof.referrer_id
    ),
    'balances', jsonb_build_object(
      'main', v_acc.main_balance,
      'bonus', v_acc.bonus_balance,
      'bonus_expires_at', v_acc.bonus_expires_at,
      'tickets', v_acc.tickets,
      'total_deposits', v_deposits
    ),
    'grid', jsonb_build_object(
      'code', v_grid.grid_code,
      'rate', v_grid.rate,
      'claimed_today', v_claimed,
      'today_income', v_income_today,
      'today_ref_income', v_ref_income_today
    )
  );
end;
$$;

grant execute on function public.get_dashboard() to authenticated;

-- ========= Referral tree RPC (3 generations) =========
create or replace function public.get_referrals_3gen()
returns table(
  level smallint,
  user_id uuid,
  public_id bigint,
  username text,
  created_at timestamptz,
  total_deposits numeric(18,2),
  total_income numeric(18,2)
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return;
  end if;

  return query
  select
    c.depth as level,
    p.user_id,
    p.public_id,
    p.username,
    p.created_at,
    (
      select coalesce(sum(d.amount),0)::numeric(18,2)
      from public.deposit_requests d
      where d.user_id = p.user_id and d.status='completed'
    ) as total_deposits,
    (
      select coalesce(sum(l.amount),0)::numeric(18,2)
      from public.wallet_ledger l
      where l.user_id = p.user_id and l.kind in ('quant_income','referral_income','scratch_bonus')
    ) as total_income
  from public.referral_closure c
  join public.profiles p on p.user_id = c.descendant_id
  where c.ancestor_id = v_uid
  order by c.depth asc, p.created_at asc;
end;
$$;

grant execute on function public.get_referrals_3gen() to authenticated;

-- ========= New user trigger: profile + 200$ bonus + referral linking =========
create or replace function public._link_referral(p_child uuid, p_ref_code text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_parent uuid;
begin
  if p_ref_code is null or length(trim(p_ref_code)) = 0 then
    return;
  end if;

  select user_id into v_parent
  from public.profiles
  where invite_code = trim(p_ref_code)
  limit 1;

  if v_parent is null or v_parent = p_child then
    return;
  end if;

  -- prevent relinking
  if exists(select 1 from public.referral_edges where child_id = p_child) then
    return;
  end if;

  insert into public.referral_edges(child_id, parent_id)
  values (p_child, v_parent)
  on conflict do nothing;

  update public.profiles
    set referrer_id = v_parent,
        updated_at = now()
  where user_id = p_child;

  -- depth 1
  insert into public.referral_closure(ancestor_id, descendant_id, depth)
  values (v_parent, p_child, 1)
  on conflict do nothing;

  -- depth 2-3 from parent's ancestors
  insert into public.referral_closure(ancestor_id, descendant_id, depth)
  select c.ancestor_id, p_child, c.depth + 1
  from public.referral_closure c
  where c.descendant_id = v_parent
    and c.depth < 3
  on conflict do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_code text;
  v_ref text;
begin
  v_code := public.make_invite_code();

  insert into public.profiles(user_id, email, username, invite_code)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'username', split_part(coalesce(new.email,''),'@',1)), v_code)
  on conflict (user_id) do update set
    email = excluded.email,
    updated_at = now();

  insert into public.user_accounts(user_id, bonus_balance, bonus_expires_at)
  values (new.id, 200.00, now() + interval '72 hours')
  on conflict (user_id) do update set
    bonus_balance = case when public.user_accounts.bonus_balance = 0 then 200.00 else public.user_accounts.bonus_balance end,
    bonus_expires_at = case when public.user_accounts.bonus_expires_at is null then now() + interval '72 hours' else public.user_accounts.bonus_expires_at end,
    updated_at = now();

  insert into public.wallet_ledger(user_id, kind, amount, meta)
  values (new.id, 'signup_bonus', 200.00, jsonb_build_object('expires_at', now() + interval '72 hours'));

  v_ref := coalesce(
    new.raw_user_meta_data->>'invite_code',
    new.raw_user_meta_data->>'ref',
    new.raw_user_meta_data->>'referral',
    null
  );

  perform public._link_referral(new.id, v_ref);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();


-- ========= Withdraw requests =========
create table if not exists public.withdraw_requests (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  token text not null check (token in ('USDT','USDC')),
  network text not null check (network in ('bep20','erc20')),
  address text not null,
  amount numeric(18,2) not null check (amount > 0),
  fee numeric(18,2) not null default 0,
  net_amount numeric(18,2) not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  tx_hash text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists withdraw_requests_user_idx on public.withdraw_requests(user_id, created_at desc);

create or replace function public.create_withdraw_request(
  p_token text,
  p_network text,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
  v_addr text;
  v_fee numeric(18,2);
  v_net numeric(18,2);
  v_old numeric(18,2);
  v_new numeric(18,2);
  v_id bigint;
  v_fee_rate numeric := 0.02; -- 2% withdrawal fee (change here if needed)
begin
  v_uid := auth.uid();
  if v_uid is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  if p_token not in ('USDT','USDC') then
    return jsonb_build_object('success', false, 'error', 'Invalid token');
  end if;
  if p_network not in ('bep20','erc20') then
    return jsonb_build_object('success', false, 'error', 'Invalid network');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Invalid amount');
  end if;

  select address into v_addr
  from public.withdrawal_addresses
  where user_id = v_uid and token = p_token and network = p_network
  limit 1;

  if v_addr is null then
    return jsonb_build_object('success', false, 'error', 'Withdrawal address not set');
  end if;

  perform public.expire_bonus_for_user(v_uid);

  select main_balance into v_old
  from public.user_accounts
  where user_id = v_uid
  for update;

  if v_old is null then
    return jsonb_build_object('success', false, 'error', 'Account not found');
  end if;

  if v_old < round(p_amount::numeric,2) then
    return jsonb_build_object('success', false, 'error', 'Insufficient balance');
  end if;

  v_fee := round(round(p_amount::numeric,2) * v_fee_rate, 2);
  v_net := round(round(p_amount::numeric,2) - v_fee, 2);
  if v_net <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount too small');
  end if;

  v_new := v_old - round(p_amount::numeric,2);

  update public.user_accounts
    set main_balance = v_new,
        updated_at = now()
  where user_id = v_uid;

  insert into public.withdraw_requests(user_id, token, network, address, amount, fee, net_amount)
  values (v_uid, p_token, p_network, v_addr, round(p_amount::numeric,2), v_fee, v_net)
  returning id into v_id;

  insert into public.wallet_ledger(user_id, kind, amount, meta)
  values (v_uid, 'withdraw_hold', -round(p_amount::numeric,2), jsonb_build_object('withdraw_id', v_id, 'token', p_token, 'network', p_network, 'fee', v_fee, 'net', v_net));

  return jsonb_build_object('success', true, 'withdraw_id', v_id, 'fee', v_fee, 'net_amount', v_net, 'new_balance', v_new);
end;
$$;

grant execute on function public.create_withdraw_request(text,text,numeric) to authenticated;
-- ========= RLS =========

-- profiles
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- user_accounts
alter table public.user_accounts enable row level security;
drop policy if exists "accounts_select_own" on public.user_accounts;
create policy "accounts_select_own" on public.user_accounts
  for select to authenticated
  using (user_id = auth.uid());

-- wallet_ledger
alter table public.wallet_ledger enable row level security;
drop policy if exists "ledger_select_own" on public.wallet_ledger;
create policy "ledger_select_own" on public.wallet_ledger
  for select to authenticated
  using (user_id = auth.uid());

-- referral tables (upline/downline visibility only within the user’s own tree)
alter table public.referral_edges enable row level security;
drop policy if exists "ref_edges_select" on public.referral_edges;
create policy "ref_edges_select" on public.referral_edges
  for select to authenticated
  using (child_id = auth.uid() or parent_id = auth.uid());

alter table public.referral_closure enable row level security;
drop policy if exists "ref_closure_select" on public.referral_closure;
create policy "ref_closure_select" on public.referral_closure
  for select to authenticated
  using (ancestor_id = auth.uid() or descendant_id = auth.uid());

-- wallets
alter table public.user_wallets enable row level security;
drop policy if exists "wallets_select_own" on public.user_wallets;
create policy "wallets_select_own" on public.user_wallets
  for select to authenticated
  using (user_id = auth.uid());

alter table public.private_keys enable row level security;
-- IMPORTANT: do not create any select policy for authenticated; keys stay server-side.

-- deposits
alter table public.deposit_requests enable row level security;
drop policy if exists "deposits_select_own" on public.deposit_requests;
create policy "deposits_select_own" on public.deposit_requests
  for select to authenticated
  using (user_id = auth.uid());

-- withdrawal addresses
alter table public.withdrawal_addresses enable row level security;
drop policy if exists "withdraw_addr_select_own" on public.withdrawal_addresses;
create policy "withdraw_addr_select_own" on public.withdrawal_addresses
  for select to authenticated
  using (user_id = auth.uid());
-- No update/delete policies for authenticated => user can’t change addresses, only admin/service role.

-- withdraw requests
alter table public.withdraw_requests enable row level security;
drop policy if exists "withdraw_requests_select_own" on public.withdraw_requests;
create policy "withdraw_requests_select_own" on public.withdraw_requests
  for select to authenticated
  using (user_id = auth.uid());

-- verifications
alter table public.user_verifications enable row level security;
drop policy if exists "verification_select_own" on public.user_verifications;
create policy "verification_select_own" on public.user_verifications
  for select to authenticated
  using (user_id = auth.uid());

-- quant
alter table public.quant_signals enable row level security;
drop policy if exists "signals_select_own" on public.quant_signals;
create policy "signals_select_own" on public.quant_signals
  for select to authenticated
  using (user_id = auth.uid());

alter table public.quant_earnings enable row level security;
drop policy if exists "earnings_select_own" on public.quant_earnings;
create policy "earnings_select_own" on public.quant_earnings
  for select to authenticated
  using (user_id = auth.uid());

alter table public.referral_earnings enable row level security;
drop policy if exists "ref_earnings_select_own" on public.referral_earnings;
create policy "ref_earnings_select_own" on public.referral_earnings
  for select to authenticated
  using (referrer_id = auth.uid());

-- scratch
alter table public.scratch_ticket_events enable row level security;
drop policy if exists "tickets_select_own" on public.scratch_ticket_events;
create policy "tickets_select_own" on public.scratch_ticket_events
  for select to authenticated
  using (user_id = auth.uid());

alter table public.scratch_events enable row level security;
drop policy if exists "scratch_events_select_own" on public.scratch_events;
create policy "scratch_events_select_own" on public.scratch_events
  for select to authenticated
  using (user_id = auth.uid());

-- config tables
alter table public.scratch_rewards enable row level security;
drop policy if exists "scratch_rewards_read" on public.scratch_rewards;
create policy "scratch_rewards_read" on public.scratch_rewards
  for select to authenticated
  using (true);

alter table public.grid_tiers enable row level security;
drop policy if exists "grid_tiers_read" on public.grid_tiers;
create policy "grid_tiers_read" on public.grid_tiers
  for select to authenticated
  using (true);
