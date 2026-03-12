/**
 * DPO2U Midnight — Generic Circuit Caller
 *
 * Invoked by CuidaBot's midnight-bridge to call any circuit on any deployed contract.
 * Usage: npx tsx scripts/call-circuit.ts <ContractName> <circuitName> [--arg1 value1 --arg2 value2 ...]
 *
 * Reads deployed addresses from .deployed-addresses.json.
 * Outputs "TX Hash: <hash>" on success for parsing by the caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pipe } from 'effect';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { setupWallet, buildProviders } from './lib/wallet-setup.js';
import type { DeployedAddresses } from '../src/types.js';

const ADDRESS_FILE = path.join(process.cwd(), '.deployed-addresses.json');
const NETWORK_ID = process.env.MIDNIGHT_NETWORK_ID || 'preprod';

// Contract name → build subdirectory mapping (must match deploy-all.ts)
const CONTRACT_BUILDS: Record<string, string> = {
  ComplianceRegistry: 'compliance-registry',
  PaymentGateway: 'payment-gateway',
  FeeDistributor: 'fee-distributor',
  AgentRegistry: 'agent-registry',
  HealthDIDRegistry: 'health-did-registry',
  HealthConsentRegistry: 'health-consent-registry',
  CuidaBotCompliance: 'cuidabot-compliance',
};

/**
 * Parse CLI arguments after contract and circuit name.
 * Format: --key value --key2 value2
 */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].substring(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Convert a 64-char hex string to Uint8Array (Bytes<32>).
 * The midnight-bridge sends hashes as 64-char hex; the SDK expects Uint8Array.
 */
function hexToBytes32(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Expected 64-char hex string for Bytes<32>, got: ${hex}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Convert argument values to the types expected by Compact circuits.
 * Bytes<32> fields become Uint8Array, numeric fields become bigint.
 */
function coerceArg(key: string, value: string): Uint8Array | bigint | string {
  // Known Bytes<32> fields — convert hex to Uint8Array
  const bytesFields = [
    'did_hash', 'issuer_did', 'grant_hash', 'vc_hash', 'subject_did',
    'patient_did', 'policy_cid', 'processing_hash', 'instance_id',
  ];
  if (bytesFields.includes(key)) {
    return hexToBytes32(value);
  }

  // Known numeric fields — convert to bigint
  const numericFields = [
    'did_type', 'role', 'min_role', 'timestamp', 'purpose_code',
    'patient_count', 'consent_count', 'encryption_score',
    'zk_proof_count', 'overall_score', 'min_score',
  ];
  if (numericFields.includes(key)) {
    return BigInt(value);
  }

  // Default: return as-is
  return value;
}

async function main() {
  const [contractName, circuitName, ...rest] = process.argv.slice(2);

  if (!contractName || !circuitName) {
    console.error('Usage: npx tsx scripts/call-circuit.ts <ContractName> <circuitName> [--arg value ...]');
    process.exit(1);
  }

  if (!(contractName in CONTRACT_BUILDS)) {
    console.error(`Unknown contract: ${contractName}`);
    console.error(`Available: ${Object.keys(CONTRACT_BUILDS).join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(ADDRESS_FILE)) {
    console.error('No deployed addresses found. Run deploy first:');
    console.error('  npm run deploy:local   (or deploy:preprod)');
    process.exit(1);
  }

  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(ADDRESS_FILE, 'utf-8'));
  const contractAddress = (addresses as any)[contractName];

  if (!contractAddress) {
    console.error(`Contract ${contractName} not found in deployed addresses.`);
    console.error('Available:', Object.keys(addresses).join(', '));
    process.exit(1);
  }

  // Parse and coerce arguments
  const rawArgs = parseArgs(rest);
  const circuitArgs: (Uint8Array | bigint | string)[] = Object.entries(rawArgs).map(
    ([key, value]) => coerceArg(key, value),
  );

  console.log(`Calling ${contractName}.${circuitName}(${Object.entries(rawArgs).map(([k, v]) => `${k}=${v}`).join(', ')})`);

  setNetworkId(NETWORK_ID);

  // Setup wallet and providers
  const ctx = await setupWallet();
  const buildDir = path.resolve(process.cwd(), 'compact', 'build', CONTRACT_BUILDS[contractName]);
  const providers = buildProviders(ctx, buildDir);

  // Load and find the deployed contract
  const { Contract } = await import(`../compact/build/${CONTRACT_BUILDS[contractName]}/contract/index.js`);

  const compiledContract = pipe(
    CompiledContract.make(contractName, Contract as any),
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(buildDir),
  );

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress,
  });

  // Call the circuit
  const callFn = (deployed.callTx as any)[circuitName];
  if (!callFn) {
    console.error(`Circuit ${circuitName} not found on contract ${contractName}.`);
    console.error('Available circuits:', Object.keys(deployed.callTx || {}).join(', '));
    await ctx.wallet.stop();
    process.exit(1);
  }

  const result = await callFn(...circuitArgs);

  // Output TX hash in format expected by midnight-bridge/index.ts
  console.log(`TX Hash: ${result.txHash}`);
  console.log(`Status: ${result.status}`);

  await ctx.wallet.stop();
}

main().catch((err) => {
  console.error('Circuit call failed:', err?.message || err);
  process.exit(1);
});
