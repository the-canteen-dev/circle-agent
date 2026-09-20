import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";
import { readFile } from "node:fs/promises";
import { decodeBatch, serializeBatch } from "./decode-batch.ts";

type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const SELLER = "0x933a2405f84c224be1ef373ba16e992e1f459682";

const app = express();

app.get("/", (_req, res) => res.redirect("/buyer.html"));
app.use(express.static("public"));

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  networks: ["eip155:5042002"],
});

app.get("/hello-world", gateway.require("$0.01"), (req: PaidRequest, res) => {
  const { payer, amount, network, transaction } = req.payment!;
  const formatted = formatUnits(BigInt(amount), 6);
  console.log(`paid ${formatted} USDC by ${payer} on ${network} settlement=${transaction ?? "?"}`);

  res.json({
    message: "hello, world — you paid for this",
    paid_by: payer,
    amount_usdc: formatted,
    network,
    settlementId: transaction,
  });
});

const GATEWAY_API = "https://gateway-api-testnet.circle.com";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ARC_DOMAIN = 26;

// Settlements older than ~the indexer's recent-tx window can't be resolved
// via the live arcscan lookup, so we hardcode known demo settlements.
const PINNED_BATCH_TX: Record<string, `0x${string}`> = {
  "c9933054-6b34-44bb-8c04-e7e9e1b8352c":
    "0xfbad1baae7fd9b88f4e1b034a4236da02012870acbd6ae83b583e85528be396e",
};

// Gateway (deposited) balance for an address. This is the balance x402
// payments actually draw from — distinct from the address's on-chain USDC
// balance, which is only what funds a deposit into the GatewayWallet.
app.get("/api/gateway-balance/:address", async (req, res) => {
  const r = await fetch(`${GATEWAY_API}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: ARC_DOMAIN, depositor: req.params.address }],
    }),
  });
  res.status(r.status).type("application/json").send(await r.text());
});

app.get("/api/settlement/:id", async (req, res) => {
  const r = await fetch(`${GATEWAY_API}/v1/x402/transfers/${req.params.id}`);
  res.status(r.status).type("application/json").send(await r.text());
});

// Batches snapshotted into data/batches/<hash>.json (see snapshot-batch.ts)
// are served as-is, so the pinned demo trace keeps working after the public
// RPC drops the tx from its hash index.
app.get("/api/decode-batch/:hash", async (req, res) => {
  const hash = req.params.hash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    res.status(400).json({ error: "not a tx hash" });
    return;
  }
  const snapshot = await readFile(`data/batches/${hash}.json`, "utf8").catch(
    () => null,
  );
  if (snapshot) {
    res.type("application/json").send(snapshot);
    return;
  }
  try {
    const decoded = await decodeBatch(hash as `0x${string}`);
    res.json(serializeBatch(decoded));
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/batch-tx/:id", async (req, res) => {
  const sr = await fetch(`${GATEWAY_API}/v1/x402/transfers/${req.params.id}`);
  if (!sr.ok) {
    res.status(sr.status).send(await sr.text());
    return;
  }
  const settlement = (await sr.json()) as { status: string; updatedAt: string };
  if (settlement.status !== "completed" && settlement.status !== "confirmed") {
    res.json({ batchTx: null, status: settlement.status });
    return;
  }
  const pinned = PINNED_BATCH_TX[req.params.id];
  if (pinned) {
    res.json({
      batchTx: pinned,
      status: settlement.status,
      explorerUrl: `${ARC_EXPLORER}/tx/${pinned}`,
    });
    return;
  }
  const tr = await fetch(
    `${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions?filter=to`,
  );
  const { items } = (await tr.json()) as {
    items: { hash: string; timestamp: string; method: string | null }[];
  };
  const updatedAt = new Date(settlement.updatedAt).getTime();
  const candidate = items.find(
    (t) =>
      t.method === "submitBatch" &&
      new Date(t.timestamp).getTime() <= updatedAt + 5_000,
  );
  res.json({
    batchTx: candidate?.hash ?? null,
    status: settlement.status,
    explorerUrl: candidate ? `${ARC_EXPLORER}/tx/${candidate.hash}` : null,
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`seller: ${SELLER}`);
});
