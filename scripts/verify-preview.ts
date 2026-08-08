/**
 * Independent on-chain verification: ask the PUBLIC preview indexer whether each deployed
 * contract address actually has on-chain state. Uses the same PublicDataProvider the SDK's
 * findDeployedContract relies on — no trust in our own deploy log.
 *   npx tsx scripts/verify-preview.ts
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
// @ts-expect-error polyfill for the indexer provider
globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

setNetworkId('preview');
const indexer = 'https://indexer.preview.midnight.network/api/v4/graphql';
const indexerWS = 'wss://indexer.preview.midnight.network/api/v4/graphql/ws';
const pdp = indexerPublicDataProvider(indexer, indexerWS, globalThis.WebSocket as any);

const dep = JSON.parse(fs.readFileSync('deployment-preview.json', 'utf8'));
const contracts = (dep.contracts ?? []).filter((c: any) => c.contractAddress);

console.log(`Verifying ${contracts.length} contracts against ${indexer}\n`);
let ok = 0;
for (const c of contracts) {
  try {
    const st: any = await pdp.queryContractState(c.contractAddress);
    if (st) {
      ok++;
      const bh = st.blockHeight ?? st.block?.height ?? st.blockHash?.slice?.(0, 12) ?? '';
      console.log(`OK    ${String(c.name).padEnd(20)} ${c.contractAddress.slice(0, 20)}…  on-chain state present ${bh ? '(block ' + bh + ')' : ''}`);
    } else {
      console.log(`MISS  ${String(c.name).padEnd(20)} ${c.contractAddress.slice(0, 20)}…  NO state on indexer`);
    }
  } catch (e: any) {
    console.log(`ERR   ${String(c.name).padEnd(20)} ${e?.message ?? e}`);
  }
}
console.log(`\nINDEPENDENT VERIFY: ${ok}/${contracts.length} contracts confirmed on-chain on the public preview indexer.`);
process.exit(ok === contracts.length ? 0 : 2);
