/**
 * Reads one Travel Rule verdict from the Midnight indexer and prints it in the common verdict
 * format (docs/VERDICT-FORMAT.md, scripts/lib/verdict.ts), with its canonical digest.
 *
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/export-verdict.ts --transfer <id|hex> [--tx <txId>] [--contract <hex>] [--plan]
 *
 * The gate address comes from --contract or deployment-<net>-v9.json (TravelRuleGate). --tx anchors
 * the verdict to the evaluateTransfer / releaseTransfer transaction: its block height and hash are
 * read from the indexer, and the contract state is read AT that block (so the verdict is the one
 * that tx produced). Without --tx the latest state is read and block/tx are null.
 * Read-only: no wallet, no transaction. --plan prints the queries without touching the network.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { networkConfig } from './lib/midnight-v9.js';
import { verdictFromLedger, verdictDigest, checkVerdict } from './lib/verdict.js';

// @ts-expect-error WebSocket polyfill for graphql-ws in Node
globalThis.WebSocket = WebSocket;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({ options: { transfer: { type: 'string' }, tx: { type: 'string' }, contract: { type: 'string' }, plan: { type: 'boolean', default: false } } });

const HEX64 = /^[0-9a-fA-F]{64}$/;
const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(Buffer.byteLength(s), 32)); return new Uint8Array(b); };
const transferIdArg = (v: string) => (HEX64.test(v) ? new Uint8Array(Buffer.from(v, 'hex')) : b32(v));

function gateAddress(net: string): string {
  if (values.contract) return values.contract.toLowerCase();
  const f = path.join(ROOT, `deployment-${net}-v9.json`);
  const a = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).contracts?.TravelRuleGate?.contractAddress : undefined;
  if (!a) throw new Error(`TravelRuleGate not in ${path.basename(f)}; pass --contract`);
  return String(a).toLowerCase();
}

async function main() {
  if (!values.transfer) throw new Error('--transfer is required');
  const netName = process.env.MIDNIGHT_NETWORK ?? 'preview';
  const contract = gateAddress(netName);
  const transfer = transferIdArg(values.transfer);
  if (values.plan) {
    console.log(JSON.stringify({ plan: { network: netName, source_chain: `midnight:${netName}`, contract, transfer_id: Buffer.from(transfer).toString('hex'),
      reads: [values.tx ? `watchForTxData(${values.tx}) -> block height/hash` : null, `queryContractState(${contract}${values.tx ? ', at that block' : ', latest'})`].filter(Boolean) } }, null, 2));
    return;
  }
  const net = networkConfig(netName);
  const pdp: any = indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS } as any);
  let block: { height: number; hash: string } | null = null;
  if (values.tx) {
    const t = await pdp.watchForTxData(values.tx);
    block = { height: Number(t.blockHeight), hash: String(t.blockHash) };
  }
  const read = await pdp.queryContractState(contract, block ? { type: 'blockHash', blockHash: block.hash } : undefined);
  if (!read) throw new Error(`no contract state for ${contract}`);
  const Gate = await import(pathToFileURL(path.join(ROOT, 'build', 'TravelRuleGate', 'contract', 'index.js')).href);
  const L = Gate.ledger(read.contractState.deserialize({ v9: ContractState }).data);
  const v = verdictFromLedger(L, transfer, { source_chain: `midnight:${netName}`, source_contract: contract, block, tx: values.tx ?? null });
  const problems = checkVerdict(v);
  if (problems.length) throw new Error('verdict failed the format check: ' + problems.join('; '));
  console.log(JSON.stringify({ verdict: v, digest: verdictDigest(v) }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
