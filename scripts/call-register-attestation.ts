#!/usr/bin/env tsx
/**
 * call-register-attestation.ts
 *
 * Calls registerAttestation() on the deployed ComplianceRegistry in Preprod
 * with known test values (B.2 — Gap 2 validation).
 *
 * Usage:
 *   tsx scripts/call-register-attestation.ts
 *
 * Prerequisites:
 *   - .deployed-addresses.json with ComplianceRegistry address
 *   - .midnight-mnemonic with wallet seed
 *   - Proof Server running on localhost:6300
 *   - tNIGHT + DUST balance in wallet
 */

import * as fs from 'fs';
import * as path from 'path';
import { pipe } from 'effect';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { setupWallet, buildProviders } from './lib/wallet-setup.js';
import { padTo32Bytes } from '../src/types.js';
import type { DeployedAddresses } from '../src/types.js';

const ADDRESS_FILE = path.join(process.cwd(), '.deployed-addresses.json');
const NETWORK_ID = process.env.MIDNIGHT_NETWORK_ID || 'preprod';

// ─── Test values (B.2 — known data for parser validation) ────────────────────
// These must match what the relayer expects to see after decoding
const TEST_COMPANY_ID = padTo32Bytes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const TEST_AGENT_DID  = padTo32Bytes('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
const TEST_POLICY_CID = padTo32Bytes('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
const TEST_SCORE      = 85n;

async function main() {
  console.log('=== DPO2U — registerAttestation() on Preprod ===\n');
  console.log('Test values:');
  console.log(`  company_id : 0x${Buffer.from(TEST_COMPANY_ID).toString('hex')}`);
  console.log(`  agent_did  : 0x${Buffer.from(TEST_AGENT_DID).toString('hex')}`);
  console.log(`  policy_cid : 0x${Buffer.from(TEST_POLICY_CID).toString('hex')}`);
  console.log(`  score      : ${TEST_SCORE}`);

  if (!fs.existsSync(ADDRESS_FILE)) {
    console.error('\n❌ No deployed addresses found.');
    console.error('Run: npm run deploy:preprod');
    process.exit(1);
  }

  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(ADDRESS_FILE, 'utf-8'));
  if (!addresses.ComplianceRegistry) {
    console.error('\n❌ ComplianceRegistry address not found in .deployed-addresses.json');
    process.exit(1);
  }

  console.log(`\nComplianceRegistry: ${addresses.ComplianceRegistry}`);
  console.log(`Network: ${NETWORK_ID}\n`);

  setNetworkId(NETWORK_ID);

  // Setup wallet
  console.log('[1/3] Setting up wallet...');
  const ctx = await setupWallet();

  // Find deployed contract
  console.log('[2/3] Connecting to ComplianceRegistry...');
  const buildDir = path.resolve(process.cwd(), 'compact', 'build', 'compliance-registry');
  const { Contract } = await import('../compact/build/compliance-registry/contract/index.js');

  const compiledContract = pipe(
    CompiledContract.make('ComplianceRegistry', Contract as any),
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(buildDir),
  );

  const providers = buildProviders(ctx, buildDir);

  const registry = await findDeployedContract(providers as any, {
    compiledContract: compiledContract as any,
    contractAddress: addresses.ComplianceRegistry,
  });

  // Call registerAttestation
  console.log('[3/3] Calling registerAttestation()...');
  const startTime = Date.now();

  const result = await registry.callTx.registerAttestation(
    TEST_COMPANY_ID,
    TEST_AGENT_DID,
    TEST_POLICY_CID,
    TEST_SCORE,
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✅ registerAttestation() succeeded in ${elapsed}s`);
  console.log(`  TX Hash:  ${(result as any).txHash}`);
  console.log(`  Status:   ${(result as any).status}`);
  console.log(`  Block:    ${(result as any).blockHeight ?? 'n/a'}`);
  console.log(`  Fees:     ${(result as any).fees?.paidFees ?? 'n/a'}`);

  console.log('\n=== Now check the relayer terminal for [DIAG] logs ===');
  console.log('Expected: state decoded with score=85 and orgHash=0x4141...41\n');

  await ctx.wallet.stop();
}

main().catch((err) => {
  console.error('\n❌ Call failed:', err?.message || err);
  process.exit(1);
});
