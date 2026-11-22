# Deposit wallet collection

The existing BEP20 handler collects USDT and USDC for new deposits. The durable worker can also collect old BEP20 balances, USDT and USDC on Ethereum, USDT on TRON, and USDT accidentally sent over opBNB to a registered BEP20 address. opBNB is a recovery route, not a customer deposit network. It uses the deposit service's contract addresses. ETH, TRX and BNB on the matching chain pay transaction fees.

Apply `treasury.sql` to the NFTALT Supabase database. A credited deposit queues its wallet. A background pass also checks registered BSC, Ethereum, opBNB and TRON deposit addresses for existing balances. The worker confirms custody before advancing gas and saves a signed transaction before sending it. On restart it checks that same transaction. `treasury_transfers` records confirmed transactions. A `hold_reason` in `treasury_lanes` identifies operations that need review. Do not modify or delete a pending transfer by hand: reconcile its on-chain hash first. When the BSC worker is in live mode, it replaces the original BEP20 sweep, avoiding competing transfers.

Set `TREASURY_MODE=observe` to preview eligible collections, or `live` to enable them. The default is `off`. In `TREASURY_POLICY`, configure only the chains to start (`bsc`, `ethereum`, `opbnb`, `tron`). Each entry takes decimal strings `maxFee` per wallet collection and `dailyFee` in the chain's native token (ETH, BNB or TRX). The optional `minStable` is in token units and defaults to one. The daily limit reserves the full gas advance as well as transaction fees. BSC and opBNB stablecoins use 18 decimals; Ethereum and TRON stablecoins use 6.

BSC, Ethereum and opBNB use the existing `ADMIN_SWEEP_ADDRESS` (the same 0x destination, on their respective chains). BSC uses `BSC_RPC_URL` or `ALCHEMY_BSC_RPC_URL`, Ethereum uses `ALCHEMY_ETH_RPC_URL`, and opBNB uses `OPBNB_RPC_URL` or the official public RPC. TRON requires the project's public `ADMIN_TRON_SWEEP_ADDRESS` (a T address) and uses `TRONGRID_API_BASE` and `TRONGRID_API_KEY` when set. Wallets with sufficient native coin pay their own fees. Put `TREASURY_BSC_GAS_PRIVATE_KEY`, `TREASURY_EVM_GAS_PRIVATE_KEY`, `TREASURY_OPBNB_GAS_PRIVATE_KEY` and `TRON_GAS_PRIVATE_KEY` in Railway as needed for gas sponsorship, with enough BSC BNB, ETH, opBNB BNB or TRX respectively. The existing `HOT_WALLET_PRIVATE_KEY` can sponsor all four chains when a dedicated key is absent; its EVM public address is shared across EVM chains but its TRON public address is different, and the gas balances are separate. Never put private keys into the SQL migration, logs, tickets or chat. If an inactive TRON address cannot simulate a transfer, configure `activationEnergy` for the TRON policy as a bounded energy-unit allowance; the worker activates that wallet, then rechecks the transfer. Start with observation and inspect the projected fees before enabling live transfers.

Example policy (the fee caps are examples to adjust after inspecting network estimates):

```json
{
  "bsc": { "maxFee": "0.002", "dailyFee": "0.02" },
  "ethereum": { "maxFee": "0.003", "dailyFee": "0.03" },
  "opbnb": { "maxFee": "0.005", "dailyFee": "0.05" },
  "tron": { "maxFee": "25", "dailyFee": "250", "activationEnergy": 150000 }
}
```

The worker never logs or returns deposit private keys. It does not move the 0.0025 ETH native balance in the sample report; native coin recovery is a separate operation. It does not change how deposits are credited or process payments from a user-supplied arbitrary address.

Run `node --test treasury.test.cjs` for the offline checks.
