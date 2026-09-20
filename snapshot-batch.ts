import { mkdir, writeFile } from "node:fs/promises";
import {
  decodeBatchFromTx,
  fetchBatchTx,
  serializeBatch,
  type BatchTx,
} from "./decode-batch.ts";

// Pins a decoded submitBatch tx into data/batches/<hash>.json so the demo
// trace keeps working after the public RPC drops the tx from its hash index
// (which happens to anything more than a few weeks old). The server serves
// the file as-is for /api/decode-batch/:hash.
//
//   npx tsx snapshot-batch.ts 0x<batch-tx-hash>
//
// Tries the RPC first; if the tx has already aged out, falls back to the
// block explorer for the calldata and to the RPC for the block timestamp.

const EXPLORER_API =
  process.env.ARC_EXPLORER_API ?? "https://testnet.arcscan.app/api/v2";
const RPC = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network";

async function fetchFromExplorer(txHash: `0x${string}`): Promise<BatchTx> {
  const r = await fetch(`${EXPLORER_API}/transactions/${txHash}`);
  if (!r.ok) throw new Error(`explorer lookup ${r.status}`);
  const tx = (await r.json()) as {
    raw_input: `0x${string}`;
    block_number: number;
    from: { hash: `0x${string}` };
    to: { hash: `0x${string}` };
  };
  const blockNumber = BigInt(tx.block_number);
  const br = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["0x" + blockNumber.toString(16), false],
    }),
  });
  const { result } = (await br.json()) as { result: { timestamp: string } | null };
  if (!result) throw new Error(`block ${blockNumber} not on RPC either`);
  return {
    txHash,
    blockNumber,
    blockTimestamp: Number(BigInt(result.timestamp)),
    relayer: tx.from.hash,
    contract: tx.to.hash,
    input: tx.raw_input,
  };
}

const txHash = process.argv[2] as `0x${string}` | undefined;
if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
  console.error("usage: tsx snapshot-batch.ts <tx-hash>");
  process.exit(1);
}

let tx: BatchTx;
let source: string;
try {
  tx = await fetchBatchTx(txHash);
  source = "rpc";
} catch {
  tx = await fetchFromExplorer(txHash);
  source = "explorer (tx aged out of the RPC's hash index)";
}

const decoded = await decodeBatchFromTx(tx);
const out = `data/batches/${txHash.toLowerCase()}.json`;
await mkdir("data/batches", { recursive: true });
await writeFile(out, JSON.stringify(serializeBatch(decoded), null, 2) + "\n");

const matched = Object.values(decoded.settlementsByBuyer).flat().length;
console.log(`source:      ${source}`);
console.log(`block:       ${decoded.blockNumber} @ ${new Date(decoded.blockTimestamp * 1000).toISOString()}`);
console.log(`entries:     ${decoded.entries.length}`);
console.log(`settlements: ${matched} matched`);
console.log(`wrote:       ${out}`);
