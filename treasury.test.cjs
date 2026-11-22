'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Interface, keccak256, Transaction, sha256 } = require('ethers');
const TronWeb = require('tronweb');
const { configs, jobsFor, nextCursor, step } = require('./treasury');
const { evmAdapter, matchingTransfer, isPositiveTransfer } = require('./treasury-evm');
const { tronAdapter, checkTronIntent } = require('./treasury-tron');

const owner = Wallet.createRandom(),
  recipient = Wallet.createRandom(),
  uid = 'b6359009-6e6f-40f9-80bb-cb8f10d91cb4';
const base = {
  TREASURY_MODE: 'live',
  ADMIN_SWEEP_ADDRESS: recipient.address,
  TREASURY_POLICY: JSON.stringify({
    ethereum: { maxFee: '0.001', dailyFee: '0.01' },
  }),
};
const ethRpcUrl = 'https://eth-mainnet.g.alchemy.com';
const contracts = {
  usdt_bep20: '0x55d398326f99059ff775485246999027b3197955',
  usdc_bep20: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  usdt_erc20: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  usdc_erc20: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  usdt_opbnb: '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3',
  usdt_trc20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};
const cfg = configs(base, ethRpcUrl, contracts)[0];
test('collections require a receiver and fee caps on each enabled chain', () => {
  const configure = (env) => configs(env, ethRpcUrl, contracts);
  assert.deepEqual(configure({}), []);
  assert.throws(() => configure({ ...base, ADMIN_SWEEP_ADDRESS: '' }), /TREASURY/);
  assert.throws(() => configure({ ...base, TREASURY_POLICY: '{"tron":{"maxFee":"12","dailyFee":"50"}}' }), /tron/);
  assert.throws(() => configure({ ...base, TREASURY_POLICY: '{"ethereum":{"maxFee":"2","dailyFee":"1"}}' }), /INVERTED/);
  for (const chain of ['base', 'arbitrum']) {
    assert.throws(() => configure({ ...base, TREASURY_POLICY: JSON.stringify({ [chain]: {} }) }), /UNKNOWN_CHAIN/);
  }
  assert.throws(() => configure({ ...base, TREASURY_POLICY: '{"ethereum":{"tokens":[]}}' }), /FIXED/);
});
test('registered EVM key covers Ethereum and opBNB; TRON uses its own address', () => {
  const tronAddress = TronWeb.address.fromPrivateKey(owner.privateKey.slice(2));
  const row = {
    user_id: uid,
    usdt_erc20_address: owner.address,
    usdc_erc20_address: recipient.address,
    usdt_bep20_address: Wallet.createRandom().address,
    usdt_trc20_address: tronAddress,
  };
  const jobs = jobsFor(row, cfg);
  assert.deepEqual(jobs.map((j) => j.symbol), ['USDT', 'USDC', 'USDT', 'USDC']);
  assert.deepEqual(jobs.map((j) => j.network), ['usdt_erc20', 'usdt_erc20', 'usdc_erc20', 'usdc_erc20']);
  assert.equal(jobsFor({ ...row, usdc_erc20_address: owner.address }, cfg).length, 2);
  const [tronCfg] = configs({
    ...base, ADMIN_TRON_SWEEP_ADDRESS: tronAddress,
    TREASURY_POLICY: '{"tron":{"maxFee":"20","dailyFee":"40"}}',
  }, ethRpcUrl, contracts);
  const tronJobs = jobsFor(row, tronCfg);
  assert.deepEqual(tronJobs.map((j) => [j.network, j.token]), [['usdt_trc20', contracts.usdt_trc20]]);
  const [opbnbCfg] = configs({
    ...base, HOT_WALLET_PRIVATE_KEY: owner.privateKey,
    TREASURY_POLICY: '{"opbnb":{"maxFee":"0.001","dailyFee":"0.01"}}',
  }, ethRpcUrl, contracts);
  assert.equal(opbnbCfg.chainId, 204);
  assert.equal(opbnbCfg.gasKey, owner.privateKey);
  assert.equal(opbnbCfg.tokens[0].minimum, 10n ** 18n);
  assert.deepEqual(jobsFor(row, opbnbCfg).map((j) => [j.network, j.token]), [
    ['usdt_bep20', opbnbCfg.tokens[0].address],
  ]);
  const [bscCfg] = configs({
    ...base, HOT_WALLET_PRIVATE_KEY: owner.privateKey,
    ALCHEMY_BSC_RPC_URL: 'https://bnb-mainnet.g.alchemy.com/v2/test',
    TREASURY_POLICY: '{"bsc":{"maxFee":"0.002","dailyFee":"0.02"}}',
  }, ethRpcUrl, contracts);
  assert.equal(bscCfg.chainId, 56);
  assert.equal(bscCfg.tokens[0].minimum, 10n ** 18n);
  assert.equal(bscCfg.gasKey, owner.privateKey);
  assert.deepEqual(jobsFor(row, bscCfg).map((j) => j.symbol), ['USDT', 'USDC']);
});
test('priority credit retains the inventory scan position', () => {
  assert.deepEqual(nextCursor({ request: 87, after: uid, position: 2 }, true), {
    after: uid,
    ack: 87,
    priority: 1,
  });
});
test('legacy no-return token, false-return token and receipt verification', () => {
  assert.equal(isPositiveTransfer('0x'), true);
  assert.equal(isPositiveTransfer('0x' + '0'.repeat(64)), false);
  const decoder = new Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const event = decoder.encodeEventLog(decoder.getEvent('Transfer'), [
    owner.address,
    recipient.address,
    30n,
  ]);
  const token = cfg.tokens[0].address;
  assert.equal(
    matchingTransfer([{ ...event, address: token }], token, owner.address, recipient.address, '30'),
    true,
  );
  assert.equal(
    matchingTransfer([{ ...event, address: token }], token, owner.address, recipient.address, '31'),
    false,
  );
});
function harness(mode = 'live') {
  const cfg2 = { ...cfg, mode };
  let pending = null,
    cursor = { user: uid, position: 0 };
  let updates = 0,
    broadcasts = 0,
    reads = 0;
  let fenced = false;
  let confirmed = false;
  let kind = 'collect';
  let wrong = false;
  const row = { user_id: uid, usdt_erc20_address: owner.address };
  const db = {
    from(name) {
      assert.equal(name, 'deposit_wallets');
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: row };
        },
      };
    },
    async rpc(name, args) {
      if (name === 'treasury_claim')
        return { data: [{ revision: updates, cursor_state: cursor, pending }] };
      if (name === 'deposit_key_envelope') {
        reads++;
        return {
          data: { address: wrong ? recipient.address : owner.address, server_cipher: 'test-only' },
        };
      }
      assert.equal(name, 'treasury_advance');
      if (fenced) return { data: false };
      updates++;
      pending = args.p_pending;
      cursor = args.p_cursor;
      return { data: true };
    },
  };
  const adapter = {
    same: (a, b) => a.toLowerCase() === b.toLowerCase(),
    async plan() {
      return { kind, from: owner.address, to: recipient.address, amount: 9n, fee: 2n };
    },
    async sign() {
      return { hash: 'test-hash', raw: 'only-one-signed-transaction' };
    },
    async inspect() {
      return confirmed ? 'confirmed' : 'broadcast';
    },
    async broadcast(p) {
      assert.equal(p, pending, 'must persist before broadcast');
      broadcasts++;
    },
  };
  return {
    run: () =>
      step(
        db,
        cfg2,
        adapter,
        () => owner.privateKey,
        () => {},
        uid,
      ),
    fence() {
      fenced = true;
    },
    confirm() {
      confirmed = true;
    },
    wrong() {
      wrong = true;
    },
    fund() {
      kind = 'fund';
    },
    get state() {
      return { pending, cursor, updates, broadcasts, reads };
    },
  };
}
test('a stale lease cannot send, and observation never requests a private key', async () => {
  const h = harness();
  h.fence();
  await h.run();
  assert.equal(h.state.broadcasts, 0);
  const o = harness('observe');
  await o.run();
  assert.equal(o.state.reads, 0);
  assert.equal(o.state.broadcasts, 0);
});
test('restart replays exactly the journalled transaction then advances the cursor after receipt', async () => {
  const h = harness();
  await h.run();
  const first = h.state.pending;
  assert.ok(first);
  await h.run();
  assert.deepEqual(h.state.pending, first);
  assert.equal(h.state.reads, 1);
  h.confirm();
  await h.run();
  assert.equal(h.state.pending, null);
  assert.equal(h.state.cursor.position, 1);
});
test('gas is only advanced to a proven custody address and a confirmed advance stays on the token job', async () => {
  const h = harness();
  h.wrong();
  h.fund();
  await h.run();
  assert.equal(h.state.broadcasts, 0);
  const ok = harness();
  ok.fund();
  await ok.run();
  ok.confirm();
  await ok.run();
  assert.equal(ok.state.cursor.position, 0);
  assert.ok(ok.state.cursor.funded);
});
test('local EVM signature commits to chain, recipient, fee and token amount', async () => {
  const adapter = evmAdapter(cfg);
  const abi = new Interface(['function transfer(address,uint256) returns(bool)']);
  const tx = {
    to: cfg.tokens[0].address,
    data: abi.encodeFunctionData('transfer', [recipient.address, 3000000n]),
    value: 0n,
    chainId: 1,
    gasLimit: 21000n,
    gasPrice: 100n,
    nonce: 4,
    type: 0,
  };
  const signed = await adapter.sign({ kind: 'collect', from: owner.address, tx }, owner.privateKey);
  const t = Transaction.from(signed.raw);
  assert.equal(t.from, owner.address);
  assert.equal(t.to, cfg.tokens[0].address);
  assert.deepEqual([...abi.decodeFunctionData('transfer', t.data)], [recipient.address, 3000000n]);
  assert.equal(t.chainId, 1n);
  assert.equal(signed.hash, keccak256(signed.raw));
  await assert.rejects(
    adapter.sign({ kind: 'collect', from: recipient.address, tx }, owner.privateKey),
    /MISMATCH/,
  );
});
test('TRON transaction field and byte validation works with genuinely serialized local transactions', () => {
  const from = '41' + owner.address.slice(2).toLowerCase(),
    to = '41' + recipient.address.slice(2).toLowerCase();
  const now = Date.now();
  const raw_data = {
    contract: [
      {
        parameter: {
          value: { amount: 11, owner_address: from, to_address: to },
          type_url: 'type.googleapis.com/protocol.TransferContract',
        },
        type: 'TransferContract',
      },
    ],
    ref_block_bytes: '1337',
    ref_block_hash: '1234567812345678',
    expiration: now + 60000,
    timestamp: now,
  };
  const tx = { raw_data };
  const u = TronWeb.utils.transaction;
  const proto = u.txJsonToPb(tx);
  tx.raw_data_hex = u.txPbToRawDataHex(proto).toLowerCase();
  tx.txID = sha256('0x' + tx.raw_data_hex).slice(2);
  const intent = { from, to, kind: 'fund', amount: '11', fee: '1000' };
  checkTronIntent(tx, intent);
  assert.throws(() => checkTronIntent(tx, { ...intent, amount: 12 }), /MISMATCH/);
  assert.throws(() => checkTronIntent({ ...tx, raw_data_hex: 'abcd' }, intent), /INVALID/);
});
test('inactive TRON wallet is funded within cap, then must pass a fresh transfer simulation', async () => {
  const deposit = TronWeb.address.fromPrivateKey(Wallet.createRandom().privateKey.slice(2));
  const receiver = TronWeb.address.fromPrivateKey(recipient.privateKey.slice(2));
  const sponsor = TronWeb.address.fromPrivateKey(owner.privateKey.slice(2));
  const originalFetch = global.fetch;
  let active = false;
  let transferable = false;
  let simulationDetails = {};
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let response;
    if (url.endsWith('/walletsolidity/getaccount')) {
      response = body.address === sponsor ? { address: sponsor, balance: 200000000 }
        : active ? { address: deposit, balance: 17000000 } : {};
    } else if (url.endsWith('/wallet/getchainparameters')) {
      response = { chainParameter: [
        { key: 'getTransactionFee', value: 1000 },
        { key: 'getEnergyFee', value: 100 },
        { key: 'getCreateNewAccountFeeInSystemContract', value: 1000000 },
        { key: 'getCreateAccountFee', value: 100000 },
      ] };
    } else if (url.endsWith('/wallet/triggerconstantcontract')) {
      const isBalance = body.function_selector === 'balanceOf(address)';
      response = { result: { result: true }, constant_result: [isBalance
        ? (50000000).toString(16).padStart(64, '0')
        : (transferable ? '1' : '0').padStart(64, '0')], energy_used: 130285 };
      if (!isBalance) Object.assign(response, simulationDetails);
    } else throw Error('UNEXPECTED_TEST_RPC');
    return { ok: true, json: async () => response };
  };
  try {
    const adapter = tronAdapter({
      tronBase: 'https://api.trongrid.io', receiver, gasKey: owner.privateKey,
      activationEnergy: 150000n, maxFee: 25000000n,
    });
    const job = { address: deposit, token: contracts.usdt_trc20, minimum: 1000000n };
    const advance = await adapter.plan(job, false);
    assert.equal(advance.kind, 'fund');
    assert.equal(advance.from, sponsor);
    assert.equal(advance.to, deposit);
    assert.ok(advance.amount > 15000000n);
    assert.ok(advance.fee + advance.projectedFee <= 25000000n);
    assert.equal((await adapter.plan(job, true)).hold, 'funded_wallet_simulation_rejected');
    active = true;
    assert.equal((await adapter.plan(job, true)).hold, 'funded_wallet_simulation_rejected');
    // Mainnet USDT returns false even when the VM simulated the intended transfer.
    const addressTopic = a => TronWeb.address.toHex(a).slice(2).toLowerCase().padStart(64, '0');
    const event = {
      address: 'G9AHnMvAgqKJ2eWErupYfdzu6hgWVUZqu',
      topics: [
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        addressTopic(deposit), addressTopic(receiver),
      ],
      data: (50000000n).toString(16).padStart(64, '0'),
    };
    simulationDetails = { transaction: { ret: [{}] }, logs: [event] };
    const simulated = await adapter.plan(job, true);
    assert.equal(simulated.kind, 'collect');
    assert.equal(simulated.to, receiver);
    assert.equal(simulated.amount, 50000000n);
    assert.equal((await adapter.plan({ ...job, token: sponsor }, true)).hold, 'funded_wallet_simulation_rejected');
    for (const wrong of [
      { logs: [{ ...event, address: receiver }] },
      { logs: [{ ...event, topics: [event.topics[0], addressTopic(receiver), addressTopic(deposit)] }] },
      { logs: [{ ...event, data: '0'.repeat(64) }] },
      { logs: [event, event] },
      { logs: [event], transaction: { ret: [{ ret: 'FAILED' }] } },
      { logs: [event], energy_used: 0 },
    ]) {
      simulationDetails = wrong;
      assert.equal((await adapter.plan(job, true)).hold, 'funded_wallet_simulation_rejected');
    }
    simulationDetails = {};
    transferable = true;
    const collection = await adapter.plan(job, true);
    assert.equal(collection.kind, 'collect');
    assert.equal(collection.to, receiver);
    assert.equal(collection.amount, 50000000n);
  } finally {
    global.fetch = originalFetch;
  }
});
test('EVM plans a bounded gas advance only for an actual eligible token balance', async () => {
  const abi = new Interface([
    'function balanceOf(address) view returns(uint256)',
    'function transfer(address,uint256) returns(bool)',
  ]);
  let amount = 30000000n,
    native = 0n;
  const sponsor = Wallet.createRandom();
  const rpc = {
    async send(m) {
      return m === 'eth_chainId' ? '0x1' : '0x3b9aca00';
    },
    async getCode() {
      return '0x';
    },
    async getBalance(a) {
      return a === sponsor.address ? 10n ** 18n : native;
    },
    async getTransactionCount() {
      return 3;
    },
    async estimateGas(tx) {
      return tx.data === '0x' ? 21000n : 65000n;
    },
    async call(tx) {
      return tx.data.startsWith('0x70a08231')
        ? abi.encodeFunctionResult('balanceOf', [amount])
        : abi.encodeFunctionResult('transfer', [true]);
    },
  };
  const a = evmAdapter({ ...cfg, gasKey: sponsor.privateKey }, rpc);
  const job = { address: owner.address, token: cfg.tokens[0].address, minimum: 1000000n };
  const f = await a.plan(job, false);
  assert.equal(f.kind, 'fund');
  assert.equal(f.to, owner.address);
  assert.ok(f.amount > 0n);
  assert.equal((await a.plan(job, true)).hold, 'funded_wallet_still_short');
  native = f.amount;
  const c = await a.plan(job, true);
  assert.equal(c.kind, 'collect');
  assert.equal(c.to, recipient.address);
  assert.equal(c.amount, 30000000n);
  amount = 1n;
  assert.equal((await a.plan(job, false)).skip, 'below_minimum');
});
test('opBNB recovers a zero-BNB stablecoin wallet using a bounded sponsor transfer', async () => {
  const abi = new Interface([
    'function balanceOf(address) view returns(uint256)',
    'function transfer(address,uint256) returns(bool)',
  ]);
  const sponsor = Wallet.createRandom();
  const [chain] = configs({
    ...base, TREASURY_OPBNB_GAS_PRIVATE_KEY: sponsor.privateKey,
    TREASURY_POLICY: '{"opbnb":{"maxFee":"0.005","dailyFee":"0.05"}}',
  }, ethRpcUrl, contracts);
  const rpc = {
    async send(method) {
      if (method === 'eth_chainId') return '0xcc';
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      throw Error('UNEXPECTED_RPC');
    },
    async getBalance(address) {
      return address === sponsor.address ? 10n ** 18n : 0n;
    },
    async getTransactionCount() {
      return 8;
    },
    async estimateGas(tx) {
      if (tx.data !== '0x' && tx.gasPrice !== 0n) {
        const e = Error('insufficient funds for gas');
        e.code = 'INSUFFICIENT_FUNDS';
        throw e;
      }
      return tx.data === '0x' ? 21000n : 70000n;
    },
    async call(tx) {
      return tx.data.startsWith('0x70a08231')
        ? abi.encodeFunctionResult('balanceOf', [30n * 10n ** 18n])
        : abi.encodeFunctionResult('transfer', [true]);
    },
  };
  const adapter = evmAdapter(chain, rpc);
  const job = { address: owner.address, token: chain.tokens[0].address, minimum: 10n ** 18n };
  const plan = await adapter.plan(job, false);
  assert.equal(plan.kind, 'fund');
  assert.equal(plan.to, owner.address);
  assert.ok(plan.amount >= plan.projectedFee);
  assert.ok(plan.fee + plan.amount <= chain.maxFee);
  assert.equal((await adapter.plan(job, true)).hold, 'funded_wallet_still_short');
  assert.equal((await adapter.plan({ ...job, address: sponsor.address }, false)).skip, 'treasury_or_sponsor');
});
test('TRON builds only USDT transfer calldata for a collection', () => {
  const from = '41' + owner.address.slice(2).toLowerCase();
  const to = '41' + recipient.address.slice(2).toLowerCase();
  const token = contracts.usdt_trc20;
  const abi = new Interface(['function transfer(address,uint256) returns(bool)']);
  const now = Date.now();
  const value = {
    owner_address: from, contract_address: TronWeb.address.toHex(token),
    data: abi.encodeFunctionData('transfer', [recipient.address, 5000000n]).slice(2),
  };
  const tx = { raw_data: {
    contract: [{ parameter: { value, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' }, type: 'TriggerSmartContract' }],
    ref_block_bytes: '1337', ref_block_hash: '1234567812345678',
    expiration: now + 60000, timestamp: now, fee_limit: 9000000,
  }};
  const u = TronWeb.utils.transaction;
  tx.raw_data_hex = u.txPbToRawDataHex(u.txJsonToPb(tx)).toLowerCase();
  tx.txID = sha256('0x' + tx.raw_data_hex).slice(2);
  const intent = { from, to, token, kind: 'collect', amount: '5000000', fee: '9500000' };
  checkTronIntent(tx, intent);
  assert.throws(() => checkTronIntent(tx, { ...intent, token: null }), /MISMATCH/);
  assert.throws(() => checkTronIntent(tx, { ...intent, to: from }), /MISMATCH/);
  assert.throws(() => checkTronIntent(tx, { ...intent, amount: '5000001' }), /MISMATCH/);
});
