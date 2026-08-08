/**
 * DPO2U Paymaster — end-to-end demo on Midnight PREVIEW (the pitch narrative, runnable).
 *
 * Proves the non-custodial DUST-as-a-Service loop with real on-chain transactions:
 *   1. A NIGHT holder (account 1) REDIRECTS its DUST generation to the controller's dust
 *      address — keeping custody of the NIGHT (non-custodial). Recorded on PaymentGateway.
 *   2. The controller's DUST balance grows from the holder's delegated NIGHT.
 *   3. A big-player customer orders a compliance attestation. The controller SEALS it on
 *      ComplianceRegistry, paying the DUST fee from its (delegated) capacity — the big-player
 *      never needed DUST. Usage is metered on-chain (recordSponsoredAttestation).
 *   4. Revenue for that sponsored capacity is booked to the LP (the holder) on FeeDistributor
 *      (recordLpRevenue) — the self-funding loop closes. NIGHT settlement is the existing
 *      client-pays.ts EARN leg (run separately for a full-value demo).
 *
 * PREREQUISITES (you provide the funded seed):
 *   - MIDNIGHT_SEED=<hex> with tNIGHT on account 0 (controller) AND account 1 (holder).
 *     Fund both addresses from the preview faucet. Print them with:
 *       MIDNIGHT_SEED=... tsx scripts/print-address.ts --account 0
 *       MIDNIGHT_SEED=... tsx scripts/print-address.ts --account 1
 *   - Proof server running (npm run start-proof-server) and the paymaster increment deployed:
 *       MIDNIGHT_SEED=... npm run deploy:paymaster
 *
 *   MIDNIGHT_SEED=<hex> NODE_OPTIONS=--max-old-space-size=12288 npm run paymaster:demo
 *   flags: --controller-account 0 --holder-account 1 --company acme --jurisdiction BR --score 82 --fee 10
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';

import * as ComplianceRegistry from '../build/ComplianceRegistry/contract/index.js';
import * as PaymentGateway from '../build/PaymentGateway/contract/index.js';
import * as FeeDistributor from '../build/FeeDistributor/contract/index.js';

import {
  NETWORKS, createWallet, waitForSync, dustOf, nightOf, dustAddressString,
  delegateDustGeneration, waitForDustPlateau, parseDustAddress,
  makeWalletProvider, joinContract, idFromString, hhmmss, type WalletCtx,
} from './dust-relay.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const repoFile = (f: string) => path.resolve(__dirname, '..', f);

function b32(s: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(buf, 0, 0, Math.min(s.length, 32));
  return new Uint8Array(buf);
}
function deriveContext(org: string, jurisdiction: string): Uint8Array {
  const n = randomBytes(16).toString('hex');
  return new Uint8Array(createHash('sha256').update(`${org}||${jurisdiction}||${n}`).digest());
}

async function main() {
  const { values } = parseArgs({
    options: {
      'controller-account': { type: 'string', default: '0' },
      'holder-account': { type: 'string', default: '1' },
      company: { type: 'string', default: 'acme-corp' },
      jurisdiction: { type: 'string', default: 'BR' },
      score: { type: 'string', default: '82' },
      threshold: { type: 'string', default: '70' },
      fee: { type: 'string', default: '10' },
      bigplayer: { type: 'string', default: 'bigplayer:acme-corp' },
      'agent-did': { type: 'string', default: 'did:dpo2u:agent:001' },
    },
  });
  setNetworkId('preview');
  const cfg = NETWORKS.preview.cfg;
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');

  const bar = '='.repeat(70);
  console.log(bar);
  console.log('  DPO2U Paymaster — non-custodial DUST-as-a-Service — E2E demo (preview)');
  console.log(bar);

  // ── Setup: controller + holder wallets ──
  console.log('\n[1/6] Bringing up controller + holder wallets...');
  const controller: WalletCtx = await createWallet(cfg, seed, Number(values['controller-account']));
  const holder: WalletCtx = await createWallet(cfg, seed, Number(values['holder-account']));
  const controllerAddr = String(controller.unshieldedKeystore.getBech32Address());
  const holderAddr = String(holder.unshieldedKeystore.getBech32Address());
  console.log(`  controller: ${controllerAddr}`);
  console.log(`  holder:     ${holderAddr}`);
  const ctrlState: any = await waitForSync(controller.wallet, 'controller');
  await waitForSync(holder.wallet, 'holder');
  const controllerDustAddr = await dustAddressString(controller);
  console.log(`  controller dust address (delegation target): ${controllerDustAddr}`);

  const holderNightBefore = nightOf(await Rx.firstValueFrom(holder.wallet.state()));
  const ctrlDustBefore = dustOf(await Rx.firstValueFrom(controller.wallet.state()));
  if (holderNightBefore <= 0n) throw new Error(`holder (account ${values['holder-account']}) has 0 NIGHT — fund it from the faucet first.`);

  // ── LEG 1 — non-custodial delegation ──
  console.log('\n[2/6] Holder delegates DUST generation to the controller (keeps its NIGHT)...');
  const delegateTx = await delegateDustGeneration(holder, parseDustAddress(controllerDustAddr));
  const holderNightAfter = nightOf(await Rx.firstValueFrom(holder.wallet.state()));
  console.log(`  holder NIGHT: before=${holderNightBefore} after=${holderNightAfter}  (custody retained — delta is only the fee)`);

  console.log('\n[3/6] Waiting for the controller DUST to build from the delegated NIGHT...');
  await waitForDustPlateau(controller);
  const ctrlDustAfter = dustOf(await Rx.firstValueFrom(controller.wallet.state()));
  console.log(`  controller DUST: before=${ctrlDustBefore} after=${ctrlDustAfter}  (fuel now backed by holder's NIGHT)`);

  // ── Join the three paymaster contracts (controller identity) ──
  const wp = makeWalletProvider(controller, ctrlState);
  const pg = await joinContract(wp, cfg, controllerAddr, 'PaymentGateway', PaymentGateway);
  const cr = await joinContract(wp, cfg, controllerAddr, 'ComplianceRegistry', ComplianceRegistry);
  const fd = await joinContract(wp, cfg, controllerAddr, 'FeeDistributor', FeeDistributor);

  const holderId = idFromString(`holder:${holderAddr}`);
  const bigplayerId = idFromString(String(values.bigplayer));
  const agentDid = b32(String(values['agent-did']));

  // Record the delegation on-chain (capacity registry). night_amount as Uint<64> (STAR units).
  console.log('\n  → PaymentGateway.registerDustDelegation(holderId, nightAmount)...');
  const regRes = await pg.callTx.registerDustDelegation(holderId, holderNightBefore);
  console.log(`    tx ${regRes?.public?.txId}`);

  // ── LEG 2 — sponsored attestation: controller seals a big-player's compliance, pays DUST ──
  console.log('\n[4/6] Sponsoring a big-player compliance attestation (fee paid from delegated DUST)...');
  const ctxBytes = deriveContext(String(values.company), String(values.jurisdiction));
  const dustBeforeSeal = dustOf(await Rx.firstValueFrom(controller.wallet.state()));
  const attRes = await cr.callTx.attestCompliance(
    b32(String(values.company)), agentDid, b32('bafy-policy-cid'),
    BigInt(String(values.threshold)), ctxBytes, BigInt(String(values.score)),
  );
  const dustAfterSeal = dustOf(await Rx.firstValueFrom(controller.wallet.state()));
  const dustCost = dustBeforeSeal - dustAfterSeal;
  console.log(`    attestation tx ${attRes?.public?.txId} (block ${attRes?.public?.blockHeight}); DUST cost ${dustCost}`);

  console.log('  → ComplianceRegistry.recordSponsoredAttestation(agentDid, bigplayerId)...');
  const meterRes = await cr.callTx.recordSponsoredAttestation(agentDid, bigplayerId);
  console.log(`    metering tx ${meterRes?.public?.txId}`);

  // ── LEG 3 — revenue share to the LP (the delegating holder) ──
  console.log('\n[5/6] Booking LP revenue share for the holder (service revenue-share)...');
  const fee = Number(values.fee);
  const lpRes = await fd.callTx.recordLpRevenue(holderId, BigInt(fee));
  console.log(`    lp-revenue tx ${lpRes?.public?.txId} (fee ${fee} booked to holder's share)`);

  // ── Result ──
  console.log('\n[6/6] Done.');
  const result = {
    network: getNetworkId(),
    at: new Date().toISOString(),
    controller: controllerAddr,
    controllerDustAddress: controllerDustAddr,
    holder: holderAddr,
    holderId: toHex(holderId),
    bigplayerId: toHex(bigplayerId),
    nonCustodial: { holderNightBefore: holderNightBefore.toString(), holderNightAfter: holderNightAfter.toString() },
    delegationTx: delegateTx,
    controllerDust: { before: ctrlDustBefore.toString(), after: ctrlDustAfter.toString() },
    onChain: {
      registerDustDelegationTx: regRes?.public?.txId,
      attestationTx: attRes?.public?.txId,
      recordSponsoredAttestationTx: meterRes?.public?.txId,
      recordLpRevenueTx: lpRes?.public?.txId,
    },
    sponsoredDustCost: dustCost.toString(),
    context: toHex(ctxBytes),
  };
  fs.writeFileSync(repoFile('paymaster-demo-result.json'), JSON.stringify(result, null, 2));
  console.log('\n' + bar);
  console.log('  ✅ Paymaster loop proven on preview. Saved paymaster-demo-result.json');
  console.log(`     · Holder kept its NIGHT (custody): ${holderNightBefore} → ${holderNightAfter}`);
  console.log(`     · Controller sealed the attestation on delegated DUST (cost ${dustCost})`);
  console.log(`     · Verify on-chain state:  MIDNIGHT_SEED=... npm run verify:paymaster`);
  console.log(bar);
  try { await (controller.wallet as any).close?.(); await (holder.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((e) => { console.error('\npaymaster-demo failed:', e?.stack ?? e); process.exit(1); });
