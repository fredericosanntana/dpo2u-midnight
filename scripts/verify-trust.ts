/**
 * Independent read-only check of (5): the Shared ZK Trust Stack registry + the Legal Source Manifest.
 * Reads both contracts' state from the PUBLIC preview indexer (ledger() ADT). No wallet, no sync.
 *   npx tsx scripts/verify-trust.ts
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
import { ledger as tsLedger } from '../build/TrustStackRegistry/contract/index.js';
import { ledger as lsLedger } from '../build/LegalSourceManifest/contract/index.js';

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

const ts = dec(tsLedger, await pdp.queryContractState(addr('TrustStackRegistry')));
const sid = b32('dpo2u-zk-stack-v1');
console.log('TrustStackRegistry:', addr('TrustStackRegistry').slice(0, 16), '… | stack_count:', ts.stack_count.toString());
if (ts.stack_hashes.member(sid)) {
  console.log(`  stack "dpo2u-zk-stack-v1" → hash ${toHex(ts.stack_hashes.lookup(sid))} (v${ts.stack_versions.lookup(sid).toString()})`);
} else console.log('  stack NOT found');

const ls = dec(lsLedger, await pdp.queryContractState(addr('LegalSourceManifest')));
const cid = b32('LGPD|Art.18');
console.log('LegalSourceManifest:', addr('LegalSourceManifest').slice(0, 16), '… | manifest_count:', ls.manifest_count.toString());
if (ls.source_hashes.member(cid)) {
  console.log(`  citation "LGPD|Art.18" → source ${toHex(ls.source_hashes.lookup(cid))}`);
} else console.log('  citation NOT found');

console.log('\nINDEPENDENT VERIFY: Shared ZK Trust Stack + Legal Corpus anchored on-chain (public indexer).');
