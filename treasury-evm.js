'use strict';
const {
  Contract,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  getAddress,
  keccak256,
} = require('ethers');

const ABI = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const feeOracle = '0x420000000000000000000000000000000000000F';
const pad = (value) => (value * 120n + 99n) / 100n;
const isPositiveTransfer = (result) =>
  result === '0x' || (result.length === 66 && BigInt(result) === 1n);

function matchingTransfer(logs, asset, sender, recipient, amount) {
  return logs.some((log) => {
    if (log.address.toLowerCase() !== asset.toLowerCase()) return false;
    try {
      const parsed = ABI.parseLog(log);
      return (
        parsed?.name === 'Transfer' &&
        getAddress(parsed.args[0]) === getAddress(sender) &&
        getAddress(parsed.args[1]) === getAddress(recipient) &&
        parsed.args[2] === BigInt(amount)
      );
    } catch {
      return false;
    }
  });
}

function evmAdapter(cfg, provider = new JsonRpcProvider(cfg.rpc)) {
  const sponsor = cfg.gasKey ? new Wallet('0x' + cfg.gasKey.replace(/^0x/, '')) : null;
  const receiver = getAddress(cfg.receiver);
  const native = (address) => provider.getBalance(address, 'latest');
  const balance = async (token, address) => {
    const data = await provider.call({
      to: token,
      data: ABI.encodeFunctionData('balanceOf', [address]),
    });
    return ABI.decodeFunctionResult('balanceOf', data)[0];
  };

  async function verifyNetwork() {
    if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(cfg.chainId))
      throw Error('WRONG_CHAIN');
  }
  async function quote(from, to, value, data, plainTransfer = false) {
    const [nonce, price] = await Promise.all([
      provider.getTransactionCount(from, 'pending'),
      provider.send('eth_gasPrice', []),
    ]);
    if (BigInt(price) <= 0n) throw Error('GAS_PRICE_UNAVAILABLE');
    const gasPrice = pad(BigInt(price));
    // For a plain EOA transfer a zero-value estimate also works on an empty source wallet.
    let est;
    const estimateValue = plainTransfer ? 0n : value;
    try {
      est = await provider.estimateGas({ from, to, data, value: estimateValue });
    } catch (e) {
      if (
        !/insufficient funds|funds for gas/i.test(
          [e.code, e.shortMessage, e.info?.error?.message].join(' '),
        )
      )
        throw e;
      // Only override the source's native gas balance. Contract storage and token balances stay real.
      est = BigInt(
        await provider.send('eth_estimateGas', [
          { from, to, data, value: '0x' + estimateValue.toString(16) },
          'latest',
          { [from]: { balance: '0x3635c9adc5dea00000' } },
        ]),
      );
    }
    const tx = { chainId: cfg.chainId, type: 0, nonce, gasPrice, gasLimit: pad(est), to, value, data };
    let l1Fee = 0n;
    if (cfg.chainId === 204) {
      const oracle = new Contract(
        feeOracle,
        ['function getL1Fee(bytes) view returns(uint256)'],
        provider,
      );
      const sample = Transaction.from({
        ...tx,
        value: plainTransfer && value > 0n ? (1n << 256n) - 1n : value,
      });
      sample.signature = { r: '0x' + '77'.repeat(32), s: '0x' + '66'.repeat(32), yParity: 1 };
      l1Fee = pad(await oracle.getL1Fee(sample.serialized));
    }
    return { tx, fee: tx.gasLimit * tx.gasPrice + l1Fee };
  }

  return {
    receiver,
    native,
    balance,
    verifyNetwork,
    same: (a, b) => getAddress(a) === getAddress(b),
    async plan(job, funded) {
      await verifyNetwork();
      const from = getAddress(job.address);
      if (from === receiver || from === sponsor?.address) return { skip: 'treasury_or_sponsor' };
      const destCode = await provider.getCode(receiver);
      // An EOA-optimized native sweep must not call arbitrary payable code.
      if (destCode !== '0x' && !job.token) return { skip: 'native_recipient_has_code' };
      const coins = await native(from);
      if (!job.token) {
        if (coins <= cfg.minNative) return { skip: 'below_minimum' };
        for (const t of cfg.tokens)
          if ((await balance(t.address, from)) >= t.minimum) return { skip: 'reserved_for_tokens' };
        const plan = await quote(from, receiver, coins, '0x', true);
        const amount = coins - plan.fee;
        if (amount < cfg.minNative || amount <= 0n) return { skip: 'net_below_minimum' };
        plan.tx.value = amount;
        return { ...plan, kind: 'collect', from, to: receiver, amount };
      }
      const amount = await balance(job.token, from);
      if (amount < job.minimum || amount === 0n) return { skip: 'below_minimum' };
      const data = ABI.encodeFunctionData('transfer', [receiver, amount]);
      if (!isPositiveTransfer(await provider.call({ from, to: job.token, data })))
        return { skip: 'simulation_rejected' };
      const plan = await quote(from, job.token, 0n, data);
      if (plan.fee > cfg.maxFee) return { skip: 'fee_cap' };
      if (coins >= plan.fee) return { ...plan, kind: 'collect', from, to: receiver, amount };
      if (funded) return { hold: 'funded_wallet_still_short' };
      const shortfall = plan.fee - coins;
      if (!sponsor) return { skip: 'needs_gas_sponsor' };
      const funding = await quote(sponsor.address, from, shortfall, '0x', true);
      if (funding.fee + plan.fee > cfg.maxFee) return { skip: 'funding_plus_collection_exceeds_cap' };
      if ((await native(sponsor.address)) < shortfall + funding.fee)
        return { skip: 'gas_sponsor_balance' };
      return {
        ...funding,
        kind: 'fund',
        from: sponsor.address,
        to: from,
        amount: shortfall,
        projectedFee: plan.fee,
      };
    },
    async sign(plan, key) {
      const signer = plan.kind === 'fund' ? sponsor : new Wallet('0x' + key.replace(/^0x/, ''));
      if (signer.address !== getAddress(plan.from)) throw Error('SIGNER_ADDRESS_MISMATCH');
      const raw = await signer.signTransaction(plan.tx);
      return { raw, hash: keccak256(raw) };
    },
    async inspect(p) {
      await verifyNetwork();
      const receipt = await provider.getTransactionReceipt(p.hash);
      if (!receipt) {
        if (Date.now() - p.created > 30 * 60 * 1000) return 'review';
        const known = await provider.getTransaction(p.hash);
        return known ? 'pending' : 'broadcast';
      }
      if ((await receipt.confirmations()) < cfg.confirmations) return 'pending';
      if (receipt.status !== 1) return 'failed';
      if (
        p.kind === 'collect' &&
        p.token &&
        !matchingTransfer(receipt.logs, p.token, p.from, p.to, p.amount)
      )
        return 'review';
      return 'confirmed';
    },
    async broadcast(p) {
      if (keccak256(p.raw) !== p.hash) throw Error('JOURNAL_HASH_MISMATCH');
      const tx = Transaction.from(p.raw);
      const tokenCall = p.kind === 'collect' && p.token;
      if (
        tx.chainId !== BigInt(cfg.chainId) ||
        getAddress(tx.from) !== getAddress(p.from) ||
        getAddress(tx.to) !== getAddress(tokenCall ? p.token : p.to) ||
        tx.value !== (tokenCall ? 0n : BigInt(p.amount)) ||
        tx.data !== (tokenCall ? ABI.encodeFunctionData('transfer', [p.to, p.amount]) : '0x')
      )
        throw Error('JOURNAL_INTENT_MISMATCH');
      const hash = await provider.send('eth_sendRawTransaction', [p.raw]);
      if (hash !== p.hash) throw Error('BROADCAST_HASH_MISMATCH');
    },
  };
}
module.exports = { evmAdapter, matchingTransfer, isPositiveTransfer, pad };
