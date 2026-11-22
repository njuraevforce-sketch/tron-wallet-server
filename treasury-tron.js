'use strict';
const crypto = require('node:crypto');
const TronWeb = require('tronweb');
const { matchingTransfer } = require('./treasury-evm');
const { Interface } = require('ethers');
const abi = new Interface(['function transfer(address,uint256) returns(bool)']);
const hex20 = (a) => '0x' + TronWeb.address.toHex(a).slice(2).toLowerCase();
const padded = (a) => hex20(a).slice(2).padStart(64, '0');
const digest = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const integer = (n) => {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v < 0) throw Error('TRON_INTEGER_RANGE');
  return v;
};
const same = (a, b) => TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();

function checkTronIntent(tx, p) {
  const raw = tx?.raw_data;
  if (
    !raw ||
    !tx.raw_data_hex ||
    digest(tx.raw_data_hex) !== tx.txID ||
    !TronWeb.utils.transaction.txCheck(tx) ||
    raw.contract?.length !== 1 ||
    raw.data ||
    raw.auths?.length
  )
    throw Error('TRON_INVALID_UNSIGNED_TRANSACTION');
  const c = raw.contract[0],
    v = c.parameter?.value;
  if (!v || c.Permission_id || c.permission_id || !same(v.owner_address, p.from))
    throw Error('TRON_UNEXPECTED_OWNER');
  if (p.kind === 'collect') {
    if (!TronWeb.isAddress(p.token)) throw Error('TRON_TOKEN_INTENT_MISMATCH');
    const data = abi.encodeFunctionData('transfer', [hex20(p.to), p.amount]).slice(2);
    if (
      c.type !== 'TriggerSmartContract' ||
      !same(v.contract_address, p.token) ||
      v.data.toLowerCase() !== data ||
      Number(v.call_value || 0) !== 0 ||
      Number(v.call_token_value || 0) !== 0 ||
      BigInt(raw.fee_limit || 0) > BigInt(p.fee)
    )
      throw Error('TRON_TOKEN_INTENT_MISMATCH');
  } else if (
    !['fund', 'trx_remainder'].includes(p.kind) || c.type !== 'TransferContract' ||
    !same(v.to_address, p.to) ||
    BigInt(v.amount) !== BigInt(p.amount)
  ) {
    throw Error('TRON_NATIVE_INTENT_MISMATCH');
  }
  if (raw.expiration <= raw.timestamp || raw.expiration - raw.timestamp > 24 * 3600000)
    throw Error('TRON_INVALID_EXPIRY');
}

function usdtTransferEvent(sim, token, fromHex, toHex, amount) {
  // With visible:true TronGrid may encode the 20-byte log address without the 0x41 prefix.
  if (token !== 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') return false;
  const emitters = [
    token, 'G9AHnMvAgqKJ2eWErupYfdzu6hgWVUZqu',
    'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
    '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
  ];
  const signature = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const word = h => h.slice(2).toLowerCase().padStart(64, '0');
  const transfers = (Array.isArray(sim.logs) ? sim.logs : []).filter(l =>
    emitters.includes(l?.address) && l.topics?.[0]?.toLowerCase() === signature);
  if (transfers.length !== 1) return false;
  const ev = transfers[0];
  return ev.topics.length === 3 && ev.topics[1]?.toLowerCase() === word(fromHex)
    && ev.topics[2]?.toLowerCase() === word(toHex)
    && ev.data?.toLowerCase() === amount.toString(16).padStart(64, '0');
}

function tronAdapter(cfg) {
  const base = cfg.tronBase;
  const headers = { 'TRON-PRO-API-KEY': cfg.apiKey || '' };
  const tron = new TronWeb({ fullHost: base, headers });
  const receiver = cfg.receiver;
  const sponsorKey = cfg.gasKey?.replace(/^0x/, '');
  const sponsor = sponsorKey ? TronWeb.address.fromPrivateKey(sponsorKey) : null;
  async function post(path, body = {}) {
    const r = await fetch(base + path, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw Error('TRON_HTTP_' + r.status);
    const j = await r.json();
    if (j.Error || j.error) throw Error('TRON_NODE_ERROR');
    return j;
  }
  const account = (a) => post('/walletsolidity/getaccount', { address: a, visible: true });
  async function call(token, from, selector, parameter) {
    const v = await post('/wallet/triggerconstantcontract', {
      owner_address: from,
      contract_address: token,
      function_selector: selector,
      parameter,
      visible: true,
    });
    if (!v.result?.result || !Array.isArray(v.constant_result)) throw Error('TRON_SIMULATION_FAILED');
    return v;
  }
  async function balance(token, from) {
    // An unactivated deposit address can own USDT. Use an active caller for this read.
    const r = await call(token, token, 'balanceOf(address)', padded(from));
    if (!/^[0-9a-fA-F]{64}$/.test(r.constant_result[0] || '')) throw Error('TRON_BALANCE_INVALID');
    return BigInt('0x' + r.constant_result[0]);
  }
  async function prices() {
    const j = await post('/wallet/getchainparameters');
    const values = Object.fromEntries((j.chainParameter || []).map((v) => [v.key, v.value]));
    const get = (k) => {
      if (!Number.isSafeInteger(values[k]) || values[k] < 0) throw Error('TRON_FEE_UNAVAILABLE');
      return BigInt(values[k]);
    };
    const bandwidth = get('getTransactionFee'),
      energy = get('getEnergyFee');
    if (!energy || !bandwidth) throw Error('TRON_ZERO_RESOURCE_PRICE');
    return {
      energy,
      bandwidth,
      creation: get('getCreateNewAccountFeeInSystemContract'),
      creationBandwidth: get('getCreateAccountFee'),
    };
  }
  return {
    receiver,
    same,
    async plan(job, funded) {
      const from = job.address;
      if (same(from, receiver) || (sponsor && same(from, sponsor)))
        return { skip: 'treasury_or_sponsor' };
      const amount = await balance(job.token, from);
      if (amount < job.minimum) return { skip: 'below_minimum' };
      const [a, rates] = await Promise.all([account(from), prices()]);
      const coins = BigInt(integer(a.balance || 0));
      let simulation;
      try {
        simulation = await call(
          job.token, from, 'transfer(address,uint256)',
          padded(receiver) + amount.toString(16).padStart(64, '0'),
        );
      } catch (e) {
        if (a.address || e.message !== 'TRON_SIMULATION_FAILED') throw e;
        if (funded) return { hold: 'funded_wallet_simulation_rejected' };
        if (!cfg.activationEnergy) return { skip: 'inactive_needs_energy_estimate' };
      }
      let energyLimit;
      if (simulation) {
        const failed = simulation.result?.result !== true || simulation.result?.message ||
          simulation.resMessage || simulation.transaction?.ret?.some(entry =>
            [entry.ret, entry.contractRet].some(v => v != null && v !== 'SUCCESS'));
        if (failed) return funded ? { hold: 'funded_wallet_simulation_rejected' } : { skip: 'simulation_rejected' };
        const ret = simulation.constant_result[0];
        const validEnergy = Number.isSafeInteger(simulation.energy_used) &&
          simulation.energy_used > 0;
        const quotedTransfer = /^0{64}$/.test(ret || '') && usdtTransferEvent(
          simulation, job.token, hex20(from), hex20(receiver), amount
        );
        const positive = ret === '' || /^0{63}1$/.test(ret || '') ||
          (a.address && quotedTransfer);
        if (!validEnergy || (!positive && !(!a.address && /^0{64}$/.test(ret || ''))))
          return funded ? { hold: 'funded_wallet_simulation_rejected' } : { skip: 'simulation_rejected' };
        // TRON can return `false` when simulating from an unactivated account
        // that already holds USDT. Advance gas only after proving custody; once
        // activated, require a new successful simulation before collecting.
        if (!positive && (!cfg.activationEnergy || funded))
          return funded ? { hold: 'funded_wallet_simulation_rejected' } : { skip: 'inactive_needs_energy_estimate' };
        const quoted = (BigInt(simulation.energy_used) * rates.energy * 120n + 99n) / 100n;
        const activation = cfg.activationEnergy * rates.energy;
        // A matched USDT event gives a measured quote even before account activation.
        // Collection still requires the activated account to pass a fresh simulation.
        energyLimit = !positive && !quotedTransfer && activation > quoted ? activation : quoted;
      } else {
        energyLimit = cfg.activationEnergy * rates.energy;
      }
      const fee = energyLimit + 500n * rates.bandwidth;
      if (fee > cfg.maxFee) return { skip: 'fee_cap' };
      if (a.address && coins >= fee)
        return { kind: 'collect', from, to: receiver, amount, fee, energyLimit };
      if (funded) return { hold: 'funded_wallet_still_short' };
      if (!sponsor) return { skip: 'needs_trx_sponsor' };
      const shortfall = fee > coins ? fee - coins : 1n;
      const fundingFee =
        400n * rates.bandwidth + (a.address ? 0n : rates.creation + rates.creationBandwidth);
      if (fundingFee + fee > cfg.maxFee) return { skip: 'funding_plus_collection_exceeds_cap' };
      if (BigInt(integer((await account(sponsor)).balance || 0)) < shortfall + fundingFee)
        return { skip: 'gas_sponsor_balance' };
      return {
        kind: 'fund',
        from: sponsor,
        to: from,
        amount: shortfall,
        fee: fundingFee,
        projectedFee: fee,
      };
    },
    async planRemainder(job, request, advance) {
      const from = job.address;
      if (!request || request.address !== from || request.receiver !== receiver ||
          !sponsor || advance?.from !== sponsor || same(from, sponsor) || same(from, receiver) ||
          !/^[1-9][0-9]{0,14}$/.test(request.balanceSun) ||
          !/^[0-9]{1,9}$/.test(request.maxFeeSun) || BigInt(request.balanceSun) > BigInt(advance.amount))
        return { hold: 'invalid_trx_remainder_request' };
      if ((await balance(job.token, from)) !== 0n)
        return { hold: 'trx_remainder_has_usdt' };
      const [source, target, resources, rates] = await Promise.all([
        account(from), account(receiver),
        post('/wallet/getaccountresource', { address: from, visible: true }), prices(),
      ]);
      const coins = BigInt(integer(source.balance || 0));
      if (!target.address || !source.address || coins === 0n || coins > BigInt(request.balanceSun))
        return { hold: 'trx_remainder_balance_changed' };
      const bandwidth = Math.max(
        integer(resources.freeNetLimit || 0) - integer(resources.freeNetUsed || 0),
        integer(resources.NetLimit || 0) - integer(resources.NetUsed || 0),
      );
      let amount = coins;
      for (let i = 0; i < 3 && amount > 0n; i++) {
        const tx = await tron.transactionBuilder.sendTrx(receiver, integer(amount), from);
        const proto = TronWeb.utils.transaction.txJsonToPb(tx);
        proto.addSignature(new Uint8Array(65));
        // java-tron reserves 64 bytes for the transaction result.
        const bytes = proto.serializeBinary().length + 64;
        const fee = bandwidth >= bytes ? 0n : BigInt(bytes) * rates.bandwidth;
        if (fee > BigInt(request.maxFeeSun) || fee > cfg.maxFee)
          return { hold: 'trx_remainder_fee_limit' };
        if (amount + fee === coins)
          return { kind: 'trx_remainder', from, to: receiver, amount, fee, tx };
        amount = coins - fee;
      }
      return { hold: 'trx_remainder_needs_bandwidth' };
    },
    async sign(p, key, job) {
      const privateKey = p.kind === 'fund' ? sponsorKey : key.replace(/^0x/, '');
      if (!same(TronWeb.address.fromPrivateKey(privateKey), p.from))
        throw Error('SIGNER_ADDRESS_MISMATCH');
      let tx;
      if (p.kind === 'collect') {
        const result = await tron.transactionBuilder.triggerSmartContract(
          job.token,
          'transfer(address,uint256)',
          { feeLimit: integer(p.energyLimit), callValue: 0 },
          [
            { type: 'address', value: p.to },
            { type: 'uint256', value: p.amount.toString() },
          ],
          p.from,
        );
        if (!result.result?.result) throw Error('TRON_CONSTRUCTION_FAILED');
        tx = result.transaction;
      } else if (p.kind === 'trx_remainder') {
        if (!same(p.to, receiver) || !same(p.from, job.address) || same(p.from, sponsor))
          throw Error('TRON_REMAINDER_INTENT_MISMATCH');
        tx = p.tx;
      } else tx = await tron.transactionBuilder.sendTrx(p.to, integer(p.amount), p.from);
      checkTronIntent(tx, { ...p, token: job.token });
      const maxSize = p.kind === 'collect' ? 500 : 400;
      if (tx.raw_data_hex.length / 2 + 100 > maxSize || tx.raw_data.expiration <= Date.now() + 10000)
        throw Error('TRON_REQUOTE');
      const signed = await tron.trx.sign(tx, privateKey);
      return { hash: signed.txID, raw: signed };
    },
    async inspect(p) {
      const [receipt, body] = await Promise.all(
        ['/walletsolidity/gettransactioninfobyid', '/walletsolidity/gettransactionbyid'].map((path) =>
          post(path, { value: p.hash }),
        ),
      );
      if (receipt.id === p.hash && body.txID === p.hash) {
        if (body.ret?.[0]?.contractRet !== 'SUCCESS' || receipt.result === 'FAILED') return 'failed';
        if (p.kind === 'trx_remainder') {
          const c = body.raw_data?.contract;
          const v = c?.[0]?.parameter?.value;
          if (c?.length !== 1 || c[0].type !== 'TransferContract' || !v ||
              !same(v.owner_address, p.from) || !same(v.to_address, receiver) ||
              String(v.amount) !== String(p.amount)) return 'review';
        }
        if (p.kind === 'collect') {
          if (receipt.receipt?.result !== 'SUCCESS') return 'failed';
          const logs = (receipt.log || []).map((l) => ({
            address: '0x' + l.address,
            topics: l.topics.map((t) => '0x' + t),
            data: '0x' + l.data,
          }));
          if (!matchingTransfer(logs, hex20(p.token), hex20(p.from), hex20(p.to), p.amount))
            return 'review';
        }
        return 'confirmed';
      }
      const observed = await post('/wallet/gettransactionbyid', { value: p.hash });
      if (observed.txID === p.hash)
        return Date.now() - p.created > 30 * 60 * 1000 ? 'review' : 'pending';
      return p.raw.raw_data.expiration <= Date.now() ? 'review' : 'broadcast';
    },
    async broadcast(p) {
      checkTronIntent(p.raw, p);
      if (p.raw.txID !== p.hash) throw Error('JOURNAL_HASH_MISMATCH');
      const r = await tron.trx.sendRawTransaction(p.raw);
      if (!r.result && r.code !== 'DUP_TRANSACTION_ERROR') throw Error('TRON_BROADCAST_UNCONFIRMED');
    },
  };
}
module.exports = { tronAdapter, checkTronIntent };
