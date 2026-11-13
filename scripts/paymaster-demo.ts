/**
 * DPO2U Paymaster — end-to-end demo on ledger v9 (MIDNIGHT_NETWORK, default preview).
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
 *      EARN leg (transferNight in scripts/agent.ts).
 *
 * PREREQUISITES (you provide the funded seed):
 *   - MIDNIGHT_SEED=<hex> with NIGHT on account 0 (controller) AND account 1 (holder). Account
 *     seeds are derived in scripts/dust-relay.ts (accountSeedHex); print the addresses with
 *       MIDNIGHT_SEED=... tsx scripts/dust-relay.ts controller-dust --account 0   (and --account 1)
 *   - Proof server running and ComplianceRegistry, PaymentGateway, FeeDistributor deployed with
 *     owner gating by the controller: MIDNIGHT_SEED=... tsx scripts/deploy-v9.ts --only ...
 *     The controller (account 0) must hold the owner secret (DPO2U_OWNER_SECRET or derived from
 *     MIDNIGHT_SEED, see scripts/owner.ts). Mainnet: same guard as every v9 script.
 *
 *   MIDNIGHT_SEED=<hex> NODE_OPTIONS=--max-old-space-size=12288 npm run paymaster:demo
 *   flags: --controller-account 0 --holder-account 1 --company acme --jurisdiction BR --score 82 --fee 10
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as ComplianceRegistry from '../build/ComplianceRegistry/contract/index.js';
import * as PaymentGateway from '../build/PaymentGateway/contract/index.js';
import * as FeeDistributor from '../build/FeeDistributor/contract/index.js';

import { networkConfig, ensureDust, masterSeedHex } from './lib/midnight-v9.js';
import { ownerSecret, scoreSalt, setScoreSalt } from './owner.js';
import {
  openAccount, currentState, dustOf, nightOf, dustAddressString,
  delegateDustGeneration, waitForDustPlateau, parseDustAddress,
  joinContract, idFromString, type WalletCtx,
} from './dust-relay.js';

const repoFile = (f: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', f);
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

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
  const net = networkConfig();
  const secret = ownerSecret(masterSeedHex(), net.name);

  const bar = '='.repeat(70);
  console.log(bar);
  console.log(`  DPO2U Paymaster — non-custodial DUST-as-a-Service — E2E demo (${net.name})`);
  console.log(bar);

  // ── Setup: controller + holder wallets ──
  console.log('\n[1/6] Bringing up controller + holder wallets...');
  const controller: WalletCtx = await openAccount(net, Number(values['controller-account']), 'controller');
  const holder: WalletCtx = await openAccount(net, Number(values['holder-account']), 'holder');
  const controllerAddr = controller.address;
  const holderAddr = holder.address;
  console.log(`  controller: ${controllerAddr}`);
  console.log(`  holder:     ${holderAddr}`);
  const controllerDustAddr = await dustAddressString(controller);
  console.log(`  controller dust address (delegation target): ${controllerDustAddr}`);

  const holderNightBefore = nightOf(await currentState(holder));
  const ctrlDustBefore = dustOf(await currentState(controller));
  if (holderNightBefore <= 0n) throw new Error(`holder (account ${values['holder-account']}) has 0 NIGHT — fund it first.`);

  // ── LEG 1 — non-custodial delegation ──
  console.log('\n[2/6] Holder delegates DUST generation to the controller (keeps its NIGHT)...');
  const delegateTx = await delegateDustGeneration(holder, parseDustAddress(controllerDustAddr, net));
  const holderNightAfter = nightOf(await currentState(holder));
  console.log(`  holder NIGHT: before=${holderNightBefore} after=${holderNightAfter}  (custody retained — delta is only the fee)`);

  console.log('\n[3/6] Waiting for the controller DUST to build from the delegated NIGHT...');
  const ctrlDustAfter = await waitForDustPlateau(controller);
  console.log(`  controller DUST: before=${ctrlDustBefore} after=${ctrlDustAfter}  (fuel now backed by holder's NIGHT)`);

  // ── Join the three paymaster contracts (controller identity) ──
  if (await ensureDust(controller) === 0n) throw new Error('Controller has no DUST to pay the contract calls.');
  const pg = await joinContract(controller, secret, 'PaymentGateway', PaymentGateway);
  const cr = await joinContract(controller, secret, 'ComplianceRegistry', ComplianceRegistry);
  const fd = await joinContract(controller, secret, 'FeeDistributor', FeeDistributor);

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
  const dustBeforeSeal = dustOf(await currentState(controller));
  // Evidence behind the demo score (fictitious company): hash of the demo inputs, recorded on-chain.
  const evidenceHash = new Uint8Array(createHash('sha256').update(`paymaster-demo|${values.company}|${values.jurisdiction}|${values.score}`).digest());
  setScoreSalt(scoreSalt(secret, ctxBytes));
  const attRes = await cr.callTx.attestCompliance(
    b32(String(values.company)), agentDid, b32('bafy-policy-cid'),
    BigInt(String(values.threshold)), ctxBytes, BigInt(String(values.score)), evidenceHash,
  ).finally(() => setScoreSalt(undefined));
  const dustAfterSeal = dustOf(await currentState(controller));
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
    network: net.name,
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
  fs.writeFileSync(repoFile(`paymaster-demo-result-${net.name}.json`), JSON.stringify(result, null, 2));
  console.log('\n' + bar);
  console.log(`  ✅ Paymaster loop proven on ${net.name}. Saved paymaster-demo-result-${net.name}.json`);
  console.log(`     · Holder kept its NIGHT (custody): ${holderNightBefore} → ${holderNightAfter}`);
  console.log(`     · Controller sealed the attestation on delegated DUST (cost ${dustCost})`);
  console.log(`     · Verify on-chain state:  MIDNIGHT_SEED=... npm run verify:paymaster`);
  console.log(bar);
  try { await controller.facade.stop(); await holder.facade.stop(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((e) => { console.error('\npaymaster-demo failed:', e?.stack ?? e); process.exit(1); });
