/**
 * Independent read-only check of the DPO2U Paymaster on-chain state (preview indexer).
 * Reads the three paymaster ledgers — decoded with each contract's ledger() ADT — with no
 * wallet and no sync:
 *   PaymentGateway.delegated_night / delegator_count   (non-custodial delegation registry)
 *   ComplianceRegistry.sponsored_usage / sponsored_total (sponsored-attestation metering)
 *   FeeDistributor.lp_shares / lp_pool / lp_count        (LP revenue-share accounting)
 *
 *   npx tsx scripts/verify-paymaster.ts
 *   optional: --holder <holder-unshielded-bech32>  --bigplayer <bigplayer-id-string>
 *     (derives the same opaque Bytes<32> id the demo used: sha256("holder:<addr>") / sha256("<id>"))
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error WS polyfill
globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger as pgLedger } from '../build/PaymentGateway/contract/index.js';
import { ledger as crLedger } from '../build/ComplianceRegistry/contract/index.js';
import { ledger as fdLedger } from '../build/FeeDistributor/contract/index.js';

const id = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

setNetworkId('preview');
const { values } = parseArgs({ options: { holder: { type: 'string' }, bigplayer: { type: 'string' } } });
const pdp = indexerPublicDataProvider(
  'https://indexer.preview.midnight.network/api/v4/graphql',
  'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  globalThis.WebSocket as any,
);
const dep = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'deployment-preview.json'), 'utf8'));
const addr = (n: string) => {
  const c = dep.contracts.find((x: any) => x.name === n);
  if (!c) throw new Error(`${n} not in deployment-preview.json — deploy the paymaster increment first (npm run deploy:paymaster)`);
  return c.contractAddress;
};
const dec = (l: any, cs: any) => { try { return l(cs.data); } catch { return l(cs); } };

const pg = dec(pgLedger, await pdp.queryContractState(addr('PaymentGateway')));
const cr = dec(crLedger, await pdp.queryContractState(addr('ComplianceRegistry')));
const fd = dec(fdLedger, await pdp.queryContractState(addr('FeeDistributor')));

console.log('DPO2U Paymaster — on-chain state (preview)\n');
console.log('PaymentGateway  ', addr('PaymentGateway').slice(0, 16), '…');
console.log(`  delegators: ${pg.delegator_count.toString()} | delegated_night entries: ${pg.delegated_night.size().toString()}`);
console.log('ComplianceRegistry', addr('ComplianceRegistry').slice(0, 16), '…');
console.log(`  sponsored total: ${cr.sponsored_total.toString()} | distinct sponsors: ${cr.sponsored_usage.size().toString()}`);
console.log('FeeDistributor  ', addr('FeeDistributor').slice(0, 16), '…');
console.log(`  lp_pool: ${fd.lp_pool.toString()} | lp_count: ${fd.lp_count.toString()} | lp_shares entries: ${fd.lp_shares.size().toString()}`);

if (values.holder) {
  const hk = id(`holder:${values.holder}`);
  const delegated = pg.delegated_night.member(hk) ? pg.delegated_night.lookup(hk).toString() : '(none)';
  const share = fd.lp_shares.member(hk) ? fd.lp_shares.lookup(hk).toString() : '(none)';
  console.log(`\nHolder ${String(values.holder).slice(0, 24)}…\n  delegated NIGHT: ${delegated} | accrued LP share: ${share}`);
}
if (values.bigplayer) {
  const bk = id(String(values.bigplayer));
  const usage = cr.sponsored_usage.member(bk) ? cr.sponsored_usage.lookup(bk).toString() : '(none)';
  console.log(`\nBig-player ${values.bigplayer}\n  sponsored txs: ${usage}`);
}

const okDeleg = pg.delegator_count > 0n;
const okSpon = cr.sponsored_total > 0n;
const okLp = fd.lp_pool > 0n;
console.log(`\nINDEPENDENT VERIFY: delegation=${okDeleg ? 'OK' : '—'} sponsorship=${okSpon ? 'OK' : '—'} lp-revenue=${okLp ? 'OK' : '—'}`);
process.exit(okDeleg && okSpon && okLp ? 0 : 2);
