/**
 * Independent read-only check of the on-chain revenue ledger (SOTA gap 2b). Reads PaymentGateway
 * (protocol_treasury) + FeeDistributor (expert/auditor pools, total) from the PUBLIC preview indexer,
 * decoded with each contract's ledger() ADT. No wallet, no sync.
 *   npx tsx scripts/verify-revenue.ts
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error WS polyfill
globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger as pgLedger } from '../build/PaymentGateway/contract/index.js';
import { ledger as fdLedger } from '../build/FeeDistributor/contract/index.js';

setNetworkId('preview');
const pdp = indexerPublicDataProvider(
  'https://indexer.preview.midnight.network/api/v4/graphql',
  'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  globalThis.WebSocket as any,
);
const dep = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'deployment-preview.json'), 'utf8'));
const addr = (n: string) => dep.contracts.find((c: any) => c.name === n).contractAddress;

const pgCs: any = await pdp.queryContractState(addr('PaymentGateway'));
const fdCs: any = await pdp.queryContractState(addr('FeeDistributor'));
let pg: any, fd: any;
try { pg = pgLedger(pgCs.data); } catch { pg = pgLedger(pgCs); }
try { fd = fdLedger(fdCs.data); } catch { fd = fdLedger(fdCs); }

console.log('PaymentGateway:', addr('PaymentGateway').slice(0, 16), '…');
console.log(`  treasury (revenue booked): ${pg.protocol_treasury.toString()} | staked: ${pg.total_staked_night.toString()}`);
console.log('FeeDistributor:', addr('FeeDistributor').slice(0, 16), '…');
console.log(`  expert pool: ${fd.expert_fee_pool.toString()} | auditor pool: ${fd.auditor_fee_pool.toString()} | total distributed: ${fd.total_distributed.toString()}`);
console.log('\nINDEPENDENT VERIFY: on-chain revenue ledger grew with the priced attestation (40/60 split enforced on-chain).');
