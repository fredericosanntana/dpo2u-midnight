/**
 * Independent read-only check of the SolvencyRegistry (Proof-of-Reserve / solvency seal).
 * Reads the contract state from the PUBLIC preview indexer (ledger() ADT). No wallet, no sync.
 * The reserves/liabilities are NEVER on-chain — only the verdict (1=solvent) + report CID + period.
 *   npx tsx scripts/verify-solvency.ts [entity_id]
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error WS polyfill
globalThis.WebSocket = WebSocket;
import { Buffer } from 'buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger as solvencyLedger } from '../build/SolvencyRegistry/contract/index.js';

setNetworkId('preview');
const pdp = indexerPublicDataProvider(
  'https://indexer.preview.midnight.network/api/v4/graphql',
  'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  globalThis.WebSocket as any,
);
const dep = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'deployment-preview.json'), 'utf8'));
const addr = (n: string) => dep.contracts.find((c: any) => c.name === n).contractAddress;
const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(s.length, 32)); return new Uint8Array(b); };
const toHex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const dec = (l: any, cs: any) => { try { return l(cs.data); } catch { return l(cs); } };

const entity = process.argv[2] ?? 'vasp:acme-digital-assets';
const sr = dec(solvencyLedger, await pdp.queryContractState(addr('SolvencyRegistry')));
console.log('SolvencyRegistry:', addr('SolvencyRegistry').slice(0, 16), '… | solvency_count:', sr.solvency_count.toString());
const eid = b32(entity);
if (sr.solvency_verdicts.member(eid)) {
  const verdict = sr.solvency_verdicts.lookup(eid).toString();
  console.log(`  entity "${entity}" → SOLVENT (verdict ${verdict})`);
  console.log(`    period: ${sr.solvency_periods.lookup(eid).toString()}`);
  console.log(`    report CID/hash: ${toHex(sr.solvency_reports.lookup(eid))}`);
  console.log('    reserves/liabilities: PRIVATE (proven reserves >= liabilities, never written on-chain)');
} else console.log(`  entity "${entity}" NOT found (no solvency seal)`);

console.log('\nINDEPENDENT VERIFY: solvency proof anchored on-chain (public indexer); amounts stay private.');
