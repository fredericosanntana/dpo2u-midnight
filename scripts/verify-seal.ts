/**
 * Independent read-only verification of a single attestation. Queries the PUBLIC preview indexer
 * for the ComplianceRegistry state, decodes it with the contract's own ledger() ADT, and reads
 * getUseCaseVerdict(evidence_hash) — no wallet, no sync.
 *   npx tsx scripts/verify-seal.ts [contractAddr] [evidence_hash_hex]
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error WS polyfill for the indexer provider
globalThis.WebSocket = WebSocket;
import { Buffer } from 'buffer';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger } from '../build/ComplianceRegistry/contract/index.js';

setNetworkId('preview');
const indexer = 'https://indexer.preview.midnight.network/api/v4/graphql';
const indexerWS = 'wss://indexer.preview.midnight.network/api/v4/graphql/ws';
const pdp = indexerPublicDataProvider(indexer, indexerWS, globalThis.WebSocket as any);

const ADDR = process.argv[2] ?? '9bd5e10849b3db1eabe54b1f3c3d30f1de89ffa1d5e4ef66e1bff58b9b93fb6d';
const EV = process.argv[3] ?? '37d266569b2796931759094451cb60531c9867caa573c9737ff12a857443f2ef';
const evBytes = new Uint8Array(Buffer.from(EV.replace(/^0x/, ''), 'hex'));

const cs: any = await pdp.queryContractState(ADDR);
if (!cs) { console.log('no contract state on indexer'); process.exit(2); }
let l: any;
try { l = ledger(cs.data); } catch { l = ledger(cs); }

console.log(`ComplianceRegistry: ${ADDR}`);
console.log(`usecase_attestation_count (total on-chain): ${l.usecase_attestation_count.toString()}`);
const present = l.usecase_verdicts.member(evBytes);
console.log(`evidence_hash ${EV.slice(0, 16)}… present: ${present}`);
if (present) {
  const v = l.usecase_verdicts.lookup(evBytes).toString();
  console.log(`verdict: ${v} (${v === '1' ? 'PASS' : v === '0' ? 'FAIL' : 'REVIEW'})`);
}
console.log(present ? '\nINDEPENDENT VERIFY: attestation confirmed on-chain (public indexer).' : '\nNOT FOUND.');
process.exit(present ? 0 : 2);
