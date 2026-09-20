# circle-agent

An **explainer companion** to Circle's <a href="https://github.com/circlefin/arc-nanopayments">arc-nanopayments</a>. Where the upstream demo shows what a production-shaped x402 app looks like (full Next.js seller dashboard, Supabase persistence, LangChain buyer agent), this repo zooms in on the single question *"what actually happens when an x402 payment settles?"*.

It does that by pairing a deliberately small paywalled server (`server.ts`) with two pieces you won't find in the upstream demo:

- **`decode-batch.ts`** — pulls a Gateway `submitBatch(...)` transaction off Arc Testnet and decodes its calldata into per-buyer balance deltas, net transfers, and (via a heuristic against Circle's facilitator API) the off-chain settlement UUIDs that landed in the batch.
- **`public/buyer.html`** — a step-by-step **payment trace UI**: buyer signs EIP-712 → facilitator settles → settlement queued → relayer batches → on-chain `submitBatch` tx → settlement marked completed. Every step links to the underlying API call or explorer page so you can follow the lifecycle by hand.

The `/hello-world` paywall is just enough surface area to generate a real settlement you can trace through both tools.

## Prerequisites

- Node.js 20+
- An Arc Testnet wallet funded with testnet USDC (MetaMask for the browser buyer, or a raw private key for the CLI buyer). Get testnet USDC from the [Circle faucet](https://faucet.circle.com/).

## Installation

```bash
npm install
```

## Running the server

```bash
npm start
```

This runs `tsx server.ts` and listens on `http://localhost:3000`.

Endpoints:
- `GET /hello-world` — paywalled at `$0.01` USDC via the Gateway middleware
- `GET /api/gateway-balance/:address` — proxies the Gateway deposited-balance lookup
- `GET /api/settlement/:id` — proxies the Gateway settlement lookup
- `GET /api/decode-batch/:hash` — decodes a `submitBatch` transaction (served from `data/batches/<hash>.json` when a snapshot exists)
- `GET /api/batch-tx/:id` — resolves a settlement id to its on-chain batch tx
- `/` — redirects to `/buyer.html` (browser-based buyer UI)

## Before you pay: deposit into the Gateway

This is the step that trips up most people on their first x402 payment. **USDC in your wallet is not what gets spent.** Gateway payments are debited from a balance you have deposited, ahead of time, into the `GatewayWallet` contract (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9` on Arc Testnet). That pre-funding is what allows the actual payment to be a bare EIP-712 signature — no transaction, no gas, no wallet popup beyond "sign".

So there are two balances to keep straight:

| Balance | Where it lives | What it's for |
| --- | --- | --- |
| **Wallet (EOA)** | your address, on-chain | gas, and funding deposits — **not** spendable by x402 |
| **Gateway (deposited)** | `GatewayWallet` contract, attributed to your address | what `/hello-world` actually debits |

A wallet holding $5 of USDC with nothing deposited will get `402 {"error":"Payment settlement failed","reason":"insufficient_balance"}` on a $0.01 call. The buyer page shows both balances side by side once you connect, and the **Deposit to Gateway** button does the one-time setup for you: `approve(GatewayWallet, amount)` on the USDC contract, then `deposit(USDC, amount)` on `GatewayWallet`. Two on-chain transactions, both paid in gas from your wallet balance (on Arc, USDC *is* the gas token — leave a little behind). On Arc Testnet the deposit is credited after roughly half a second; other chains wait minutes for block confirmations.

![Live demo — wallet balance vs. Gateway balance, with the deposit button](public/img/live-demo-balances.png)

To check a Gateway balance by hand:

```bash
curl -s -X POST https://gateway-api-testnet.circle.com/v1/balances \
  -H "Content-Type: application/json" \
  -d '{"token":"USDC","sources":[{"domain":26,"depositor":"0xYOUR_ADDRESS"}]}'
```

The server also proxies this at `GET /api/gateway-balance/:address`, which is what the page uses.

## Running the buyer (browser — recommended)

With the server running, open `http://localhost:3000/` in a browser. The page (`public/buyer.html`) connects to MetaMask, prompts you to switch to Arc Testnet, shows your wallet vs. Gateway balances, lets you deposit if needed, and signs the EIP-712 payment authorization in the wallet. No env vars or private keys required.

After paying, the page renders a six-step **payment trace** for the settlement you just created, with every step linked to the corresponding facilitator API call or block-explorer page. You can also paste any existing settlement UUID into the "Payment trace" input to inspect a past payment — the page ships with one pre-loaded so the trace is browseable without paying first.

## Payment lifecycle walkthrough

What `public/buyer.html` actually shows after a `/hello-world` payment, step by step. Open the page locally to interact with the live links; the screenshots below are what you'd see for the pre-loaded demo settlement `c9933054-6b34-44bb-8c04-e7e9e1b8352c`.

### 1. Buyer signs an EIP-712 payment authorization (off-chain)

The buyer's wallet signs a `TransferWithAuthorization` typed-data message scoped to the `GatewayWallet` contract. No transaction, no gas — just a signature that authorizes a debit up to `value` before `validBefore`.

![Step 1 — EIP-712 sign](public/img/trace-step-1-eip712.png)

### 2. Merchant's middleware settles via the Circle facilitator

The server's `createGatewayMiddleware` (see `server.ts`) forwards the signed authorization to Circle's facilitator with `POST /v1/x402/settle`. The facilitator returns a **settlement UUID** — not yet a tx hash.

![Step 2 — facilitator settle](public/img/trace-step-2-facilitator.png)

### 3. Settlement queued (`status: received`)

Circle's Gateway accepts the signed auth, optimistically debits the buyer's balance, and returns the UUID. The on-chain tx hasn't fired yet — the relayer batches multiple payments before broadcasting. Inspect the settlement via `GET /v1/x402/transfers/:id` (also exposed locally at `/api/settlement/:id`).

![Step 3 — settlement queued](public/img/trace-step-3-queued.png)

### 4. Relayer batches multiple transfers

Circle's relayer (an EOA controlled by Circle — `0xc73e…a884` for the pinned demo settlement, but Circle may rotate it) waits for a flush trigger (volume or timer) and then calls `submitBatch(calldataBytes, signature)` on the `GatewayWallet` contract. One on-chain tx settles many buyers' payments at once. On Arc Testnet, traffic is low and you should usually expect a ~10 minute wait before your settlement makes it on-chain — under heavy traffic the relayer flushes much faster (every few seconds), but you won't see that on testnet today.

**A batch is a time window, not a group of related payments.** It is not "the batch for your `/hello-world` call". When the flush fires, the relayer sweeps up *every* Gateway transfer pending on the domain — other people's demos, other apps, other sellers, amounts that have nothing to do with yours. Expect the decoded batch to contain rows you don't recognise: a 25 USDC transfer between two strangers sitting next to your 0.01 is normal, and is in fact the whole point. The fixed cost of one on-chain transaction is split across everyone who landed in the same window, which is what makes a one-cent payment economical at all.

Two consequences worth knowing when you read the batch:

- **Most rows aren't yours.** The page tags your own debit with a `you` badge; ignore the rest.
- **One row per address.** If you made several payments before the flush, they are summed into a single net delta, so your row can be larger than the settlement you're tracing. The individual settlement UUIDs never go on-chain — `decode-batch.ts` recovers them by matching `updatedAt` timestamps against the block.

![Step 4 — relayer batches](public/img/trace-step-4-relayer.png)

### 5. On-chain `submitBatch` tx

This is the step `decode-batch.ts` exists to unpack. The page resolves the batch tx via `/api/batch-tx/:id`, then `/api/decode-batch/:hash` pulls apart `calldataBytes` to show the `batchId`, the per-buyer signed deltas (negative = debit, positive = credit, sum = zero), and the net transfers inferred by pairing equal-and-opposite deltas. The buyer's own row is highlighted with a `you` badge.

![Step 5 — on-chain submitBatch](public/img/trace-step-5-onchain.png)

### 6. Settlement marked completed

After the batch tx is mined, Circle updates the settlement record. `updatedAt` on completed settlements aligns with the batch tx's block timestamp (±2s), which is the heuristic `decode-batch.ts` uses to attach settlement UUIDs back to the buyer entries above.

![Step 6 — settlement marked completed](public/img/trace-step-6-completed.png)

## Running the buyer (CLI — optional)

Only use this if you want to pay from a raw private key instead of MetaMask. In a separate terminal, with the server running:

```bash
export PRIVATE_KEY=0x...   # Arc Testnet wallet private key
npm run buyer              # pays http://localhost:3000/hello-world
```

To pay a different URL:

```bash
npx tsx buyer.ts http://localhost:3000/hello-world
```

## Decoding a batch transaction (CLI)

`decode-batch.ts` is the centerpiece of this repo. It takes a Gateway `submitBatch(...)` transaction hash and pulls apart the on-chain calldata to show:

- the `batchId` and `relayer` that submitted the batch,
- the `(address, int256 delta)` pairs encoded inside `calldataBytes` — i.e. every buyer/recipient whose balance shifted in that batch,
- the **net transfers** inferred by pairing each negative delta with an equal-and-opposite positive,
- and the **off-chain settlement UUIDs** for each buyer, looked up against Circle's facilitator API and matched by block-timestamp window. Settlement UUIDs aren't stored on-chain, so this is a heuristic — useful for tracing demo payments, but expect aggregate deltas (one entry can be the sum of several settlements that landed in the same batch window).

`decode-batch.ts` is also imported by the server's `/api/decode-batch/:hash` endpoint, which is what the browser trace UI calls.

```bash
npx tsx decode-batch.ts 0xfbad1baae7fd9b88f4e1b034a4236da02012870acbd6ae83b583e85528be396e
```

That hash is the batch tx for the demo settlement pinned in `public/buyer.html`. Replace it with any `submitBatch(...)` tx hash on Arc Testnet.

### Pinning a batch so the demo doesn't rot

Public RPC nodes only keep the transaction-hash index for a recent window of blocks. After a few weeks, `getTransaction` for an old batch returns nothing even though the block is still served — which is exactly what happened to the pinned demo batch above. To keep the default trace deterministic, decoded batches can be snapshotted into the repo:

```bash
npx tsx snapshot-batch.ts 0x<batch-tx-hash>
```

That writes `data/batches/<hash>.json` in the same shape `/api/decode-batch/:hash` returns, and the server serves the file as-is when it exists. The script tries the RPC first and falls back to the block explorer (which keeps its own database) for the calldata when the tx has already aged out. The pinned demo batch is committed this way; re-run the script if you re-pin a different settlement.

Override the RPC endpoint with `ARC_TESTNET_RPC` (default: `https://rpc.testnet.arc.network`):

```bash
ARC_TESTNET_RPC=https://your.rpc.url npx tsx decode-batch.ts 0x<batch-tx-hash>
```

You can find more batch tx hashes by clicking through from the buyer page's "Payment trace" section, or by querying `/api/batch-tx/:settlement-id`.

## Configuration

The seller address, facilitator URL, and Arc Testnet network id are hardcoded near the top of `server.ts`. Edit those constants to point at a different seller wallet or network.
