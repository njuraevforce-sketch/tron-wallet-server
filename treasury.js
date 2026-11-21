'use strict';
const { randomUUID } = require('node:crypto');
const { Wallet, getAddress, parseUnits, formatUnits, ZeroAddress } = require('ethers');
const TronWeb = require('tronweb');
const { evmAdapter } = require('./treasury-evm');
const { tronAdapter } = require('./treasury-tron');

const fields = ['usdt_bep20', 'usdc_bep20', 'usdt_erc20', 'usdc_erc20', 'usdt_trc20'];
const projection = ['user_id', ...fields.map((n) => n + '_address')].join(',');
const catalog = {
  ethereum: {
    chainId: 1,
    unit: 18,
    confirmations: 12,
    symbol: 'ETH',
    assets: [
      ['USDT', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6],
      ['USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6],
    ],
  },
  bsc: {
    chainId: 56,
    unit: 18,
    confirmations: 15,
    symbol: 'BNB',
    assets: [
      ['USDT', '0x55d398326f99059ff775485246999027b3197955', 18],
      ['USDC', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18],
    ],
  },
  opbnb: {
    chainId: 204,
    unit: 18,
    confirmations: 24,
    symbol: 'BNB',
    assets: [['USDT', '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3', 18]],
  },
  tron: { unit: 6, symbol: 'TRX', assets: [['USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6]] },
};
function positive(s, decimals) {
  if (typeof s !== 'string' || !/^\d+(?:\.\d+)?$/.test(s)) throw Error('INVALID_DECIMAL_POLICY');
  const n = parseUnits(s, decimals);
  if (n <= 0n) throw Error('POSITIVE_POLICY_REQUIRED');
  return n;
}
function configs(env, urls) {
  const limits = JSON.parse(env.TREASURY_POLICY || '{}');
  const mode = env.TREASURY_MODE || 'off';
  if (!['off', 'observe', 'live'].includes(mode)) throw Error('TREASURY_MODE_INVALID');
  if (mode === 'off') return [];
  const sources = {
    ethereum: urls.eth,
    bsc: urls.bsc,
    opbnb: env.OPBNB_RPC_URL || 'https://opbnb-mainnet-rpc.bnbchain.org',
  };
  const entries = Object.entries(limits);
  if (!entries.length) throw Error('TREASURY_POLICY_REQUIRED');
  return entries.map(([name, p]) => {
    const base = catalog[name];
    if (!base) throw Error('UNKNOWN_CHAIN');
    if (name === 'bsc' && mode === 'live' && env.TREASURY_BSC_OWNER !== 'worker')
      throw Error('BSC_HANDOVER_REQUIRED');
    const isTron = name === 'tron';
    const receiver = isTron
      ? env.ADMIN_TRON_SWEEP_ADDRESS || env.TRON_SWEEP_ADDRESS
      : env.ADMIN_SWEEP_ADDRESS;
    if (
      isTron
        ? !TronWeb.isAddress(receiver) || /^41(?:0{40})$/i.test(TronWeb.address.toHex(receiver))
        : !receiver || getAddress(receiver) === ZeroAddress
    )
      throw Error('MISSING_OR_INVALID_TREASURY_' + name);
    const normalize = (a) =>
      isTron ? TronWeb.address.fromHex(TronWeb.address.toHex(a)) : getAddress(a.toLowerCase());
    const tokens = base.assets.map(([symbol, address, decimals]) => ({
      symbol,
      address: normalize(address),
      decimals,
      minimum: positive(p.minStable || '1', decimals),
    }));
    for (const t of p.tokens || []) {
      const trc10 = isTron && t.standard === 'TRC10';
      if (t.standard && t.standard !== (isTron ? 'TRC20' : 'ERC20') && !trc10)
        throw Error('INVALID_TOKEN_STANDARD');
      if (
        !/^[\w.-]{1,20}$/.test(t.symbol) ||
        !Number.isInteger(t.decimals) ||
        t.decimals < 0 ||
        t.decimals > 36 ||
        (trc10
          ? !/^[1-9][0-9]{5,18}$/.test(t.address)
          : isTron
            ? !TronWeb.isAddress(t.address)
            : !/^0x[0-9a-f]{40}$/i.test(t.address))
      )
        throw Error('INVALID_TOKEN_POLICY');
      const address = trc10 ? String(t.address) : normalize(t.address);
      if (tokens.some((x) => x.address === address) || (!isTron && address === ZeroAddress))
        throw Error('DUPLICATE_OR_ZERO_TOKEN');
      tokens.push({
        symbol: t.symbol,
        address,
        decimals: t.decimals,
        minimum: positive(t.minimum, t.decimals),
      });
    }
    const maxFee = positive(p.maxFee, base.unit),
      dailyFee = positive(p.dailyFee, base.unit);
    if (maxFee > dailyFee) throw Error('FEE_LIMITS_INVERTED');
    const sponsorKey = isTron ? env.TRON_GAS_PRIVATE_KEY : env.TREASURY_EVM_GAS_PRIVATE_KEY;
    if (!isTron && (!sources[name] || new URL(sources[name]).protocol !== 'https:'))
      throw Error('HTTPS_RPC_REQUIRED');
    if (
      p.activationEnergy !== undefined &&
      (!Number.isSafeInteger(p.activationEnergy) || p.activationEnergy <= 0)
    )
      throw Error('INVALID_ACTIVATION_ENERGY');
    return {
      ...base,
      name,
      mode,
      receiver: normalize(receiver),
      gasKey: sponsorKey,
      apiKey: env.TRONGRID_API_KEY,
      rpc: sources[name],
      maxFee,
      dailyFee,
      minNative: positive(p.minNative, base.unit),
      tokens,
      activationEnergy: BigInt(p.activationEnergy || 0),
    };
  });
}
function jobsFor(row, cfg) {
  const addresses = new Map();
  for (const n of fields) {
    if ((cfg.name === 'tron') !== n.endsWith('_trc20')) continue;
    const a = row[n + '_address'];
    if (
      typeof a !== 'string' ||
      (cfg.name === 'tron' ? !TronWeb.isAddress(a) : !/^0x[0-9a-f]{40}$/i.test(a))
    )
      continue;
    const address = cfg.name === 'tron' ? a : getAddress(a.toLowerCase());
    if (!addresses.has(address)) addresses.set(address, n);
  }
  const jobs = [];
  for (const [address, network] of addresses) {
    for (const t of cfg.tokens)
      jobs.push({
        user: row.user_id,
        network,
        address,
        token: t.address,
        symbol: t.symbol,
        minimum: t.minimum,
      });
    jobs.push({ user: row.user_id, network, address, token: null, symbol: cfg.symbol });
  }
  return jobs;
}
function checked(q) {
  if (q.error) throw Error('TREASURY_DB_' + String(q.error.code || 'ERROR'));
  return q.data;
}
function nextCursor(c, last) {
  if (!last) return { ...c, position: c.position + 1, funded: false };
  if (c.request) return { after: c.after, ack: c.request, priority: (c.priority || 0) + 1 };
  return { after: c.user, priority: 0 };
}
async function selectJob(db, cfg, input) {
  let c = { ...input };
  if (!c.user && (c.priority || 0) < 5) {
    const [r] = checked(
      await db.from('treasury_requests').select('id,user_id').eq('chain', cfg.name).order('id').limit(1),
    );
    if (r) c = { ...c, request: r.id, user: r.user_id, position: 0 };
  }
  let row;
  if (c.user)
    row = checked(
      await db.from('deposit_wallets').select(projection).eq('user_id', c.user).maybeSingle(),
    );
  else {
    if (c.wake && c.wake > Date.now()) return { idle: true, cursor: { ...c, priority: 0 } };
    let q = db.from('deposit_wallets').select(projection).order('user_id').limit(1);
    if (c.after) q = q.gt('user_id', c.after);
    [row] = checked(await q);
    if (!row) return { idle: true, cursor: { wake: Date.now() + 30 * 60000, priority: 0 } };
    c = { ...c, user: row.user_id, position: 0 };
  }
  const jobs = row ? jobsFor(row, cfg) : [];
  const job = jobs[c.position];
  return { cursor: c, next: nextCursor(c, c.position + 1 >= jobs.length), job };
}
async function step(db, cfg, adapter, unlock, log, owner) {
  const [lane] = checked(await db.rpc('treasury_claim', { p_chain: cfg.name, p_worker: owner }));
  if (!lane) return false;
  const pending = lane.pending,
    c = lane.cursor_state;
  async function save(cursor, p = null, fee = 0n, event = null, hold = null) {
    return checked(
      await db.rpc('treasury_advance', {
        p_chain: cfg.name,
        p_worker: owner,
        p_revision: lane.revision,
        p_cursor: cursor,
        p_pending: p,
        p_fee: fee.toString(),
        p_daily_cap: cfg.dailyFee.toString(),
        p_event: event,
        p_hold: hold,
      }),
    );
  }
  if (pending) {
    if (!adapter.same(pending.receiver, cfg.receiver)) {
      await save(c, pending, 0n, null, 'recipient_changed_with_pending_transaction');
      return false;
    }
    const state = await adapter.inspect(pending);
    if (state === 'broadcast') {
      // A different worker may own the lease later. Both may only publish these exact signed bytes.
      if (cfg.mode === 'live') await adapter.broadcast(pending);
      await save(c, pending);
      return false;
    }
    if (state === 'pending') {
      await save(c, pending);
      return false;
    }
    const { raw, next, ...event } = pending;
    if (state !== 'confirmed') {
      await save(c, pending, 0n, { ...event, state }, 'review_' + state);
      return false;
    }
    const cursor =
      pending.kind === 'fund' ? { ...c, funded: { address: pending.to, token: pending.token } } : next;
    await save(cursor, null, 0n, { ...event, state });
    return true;
  }
  const { cursor, next, job, idle } = await selectJob(db, cfg, c);
  if (idle) {
    await save(cursor);
    return false;
  }
  if (!job) {
    await save(next);
    return true;
  }
  if (
    cursor.funded &&
    (cursor.funded.token !== job.token || !adapter.same(cursor.funded.address, job.address))
  ) {
    await save(cursor, null, 0n, null, 'wallet_changed_after_funding');
    return false;
  }
  const plan = await adapter.plan(job, !!cursor.funded);
  if (plan.hold) {
    await save(cursor, null, 0n, null, plan.hold);
    return false;
  }
  if (plan.skip || plan.fee > cfg.maxFee) {
    if (plan.skip !== 'below_minimum') log(cfg.name, job.symbol, plan.skip || 'fee_cap', job.address);
    await save(next);
    return true;
  }
  if (cfg.mode === 'observe') {
    log(
      cfg.name,
      job.symbol,
      'preview_' + plan.kind,
      job.address,
      String(plan.amount),
      formatUnits(plan.fee, cfg.unit),
    );
    await save(next);
    return true;
  }
  // Prove custody before even funding a source. Legacy records may point to an obsolete key.
  const { data, error } = await db.rpc('deposit_key_envelope', {
    p_user_id: job.user,
    p_network: job.network,
  });
  if (error) throw Error('TREASURY_KEY_LOOKUP');
  if (!data?.server_cipher || !data.address || !adapter.same(job.address, data.address)) {
    log(cfg.name, job.symbol, 'unmatched_wallet', job.address);
    await save(next);
    return true;
  }
  const key = unlock(data.server_cipher);
  const publicAddress =
    cfg.name === 'tron'
      ? TronWeb.address.fromPrivateKey(key.replace(/^0x/, ''))
      : new Wallet('0x' + key.replace(/^0x/, '')).address;
  if (!adapter.same(publicAddress, job.address)) throw Error('SIGNER_ADDRESS_MISMATCH');
  const signed = await adapter.sign(plan, key, job);
  const p = {
    ...signed,
    next,
    receiver: cfg.receiver,
    kind: plan.kind,
    from: plan.from,
    to: plan.to,
    token: job.token,
    symbol: plan.kind === 'fund' ? cfg.symbol : job.symbol,
    sourceAsset: job.symbol,
    amount: String(plan.amount),
    fee: String(plan.fee),
    created: Date.now(),
  };
  // Count the maximum gas advance as well as the sponsor's own transaction fee.
  const reservation = plan.fee + (plan.kind === 'fund' ? plan.amount : 0n);
  if (await save(cursor, p, reservation)) await adapter.broadcast(p);
  return false;
}
function startTreasury({ db, env, urls, decrypt, log = console.log }) {
  const chains = configs(env, urls);
  const owner = randomUUID(),
    busy = new Set();
  const managed = new Set(chains.filter((c) => c.mode === 'live').map((c) => c.name));
  for (const cfg of chains) {
    const adapter = cfg.name === 'tron' ? tronAdapter(cfg) : evmAdapter(cfg);
    const tick = async () => {
      if (busy.has(cfg.name)) return;
      busy.add(cfg.name);
      try {
        for (let i = 0; i < 8; i++) if (!(await step(db, cfg, adapter, decrypt, log, owner))) break;
      } catch (e) {
        // Provider errors can include signed bytes, URLs or keys. Emit only known local error codes.
        const message = String(e.message || '');
        log(cfg.name, 'worker', /^[A-Z_0-9]{2,80}$/.test(message) ? message : 'RPC_OR_DATABASE_RETRY');
      } finally {
        busy.delete(cfg.name);
      }
    };
    const timer = setInterval(tick, 10000);
    timer.unref?.();
    void tick();
  }
  return managed;
}
module.exports = { configs, jobsFor, selectJob, nextCursor, step, startTreasury };
