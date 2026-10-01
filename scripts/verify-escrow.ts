/**
 * Independent read-only verification of a ComplianceEscrow. Queries the PUBLIC preview indexer,
 * decodes the contract state with its own ledger() ADT, and reads getEscrowStatus — no wallet/sync.
 *   npx tsx scripts/verify-escrow.ts [contractAddr] [escrow_id]
 * status: 0 = PENDING, 1 = RELEASED, 2 = REFUNDED
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error WS polyfill for the indexer provider
globalThis.WebSocket = WebSocket;
import { Buffer } from 'buffer';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger } from '../build/ComplianceEscrow/contract/index.js';

setNetworkId('preview');
const pdp = indexerPublicDataProvider(
  'https://indexer.preview.midnight.network/api/v4/graphql',
  'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  globalThis.WebSocket as any,
);

const ADDR = process.argv[2] ?? 'c7f6b2243c09454f270d95e23cde7ed01ed167e60675cab07449ea2d5436a6b9';
const ESCROW_ID = process.argv[3] ?? 'esc-demo-20260629200358';
const key = Buffer.alloc(32);
Buffer.from(ESCROW_ID, 'utf-8').copy(key, 0, 0, Math.min(ESCROW_ID.length, 32));

const cs: any = await pdp.queryContractState(ADDR);
if (!cs) { console.log('no contract state on indexer'); process.exit(2); }
let l: any;
try { l = ledger(cs.data); } catch { l = ledger(cs); }

console.log(`ComplianceEscrow: ${ADDR}`);
console.log(`escrow_count: ${l.escrow_count.toString()} | released_count: ${l.released_count.toString()} | refunded_count: ${l.refunded_count.toString()}`);
console.log(`total_released_amount: ${l.total_released_amount.toString()}`);
const present = l.escrow_status.member(new Uint8Array(key));
console.log(`escrow "${ESCROW_ID}" present: ${present}`);
if (present) {
  const st = l.escrow_status.lookup(new Uint8Array(key)).toString();
  const label = st === '1' ? 'RELEASED ✓' : st === '0' ? 'PENDING' : st === '2' ? 'REFUNDED' : '?';
  console.log(`status: ${st} (${label})`);
  console.log(st === '1' ? '\nINDEPENDENT VERIFY: escrow RELEASED on-chain via ZK attest-and-release (public indexer).' : '\nescrow not released.');
  process.exit(st === '1' ? 0 : 2);
}
process.exit(2);
