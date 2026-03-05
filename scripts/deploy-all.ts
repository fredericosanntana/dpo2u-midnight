import * as fs from 'fs';
import * as path from 'path';
import { pipe } from 'effect';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { setupWallet, buildProviders, type WalletContext } from './lib/wallet-setup.js';
import type { DeployedAddresses } from '../src/types.js';

const ADDRESS_FILE = path.join(process.cwd(), '.deployed-addresses.json');

// Contract name → build subdirectory mapping
const CONTRACT_BUILDS: Record<string, string> = {
  ComplianceRegistry: 'compliance-registry',
  PaymentGateway: 'payment-gateway',
  FeeDistributor: 'fee-distributor',
  AgentRegistry: 'agent-registry',
};

// Determine network from CLI args
const networkArg = process.argv.find((a) => a.startsWith('--network='))?.split('=')[1]
  || (process.argv.includes('--network') ? process.argv[process.argv.indexOf('--network') + 1] : undefined)
  || 'preprod';

const NETWORK_ID = networkArg === 'local' ? 'undeployed' : networkArg;

async function deployOne(
  name: string,
  ctx: WalletContext,
): Promise<string> {
  console.log(`\n  Deploying ${name}...`);

  const buildDir = path.resolve(process.cwd(), 'compact', 'build', CONTRACT_BUILDS[name]);
  const { Contract } = await import(`../compact/build/${CONTRACT_BUILDS[name]}/contract/index.js`);

  // Each contract needs providers with its own ZK config (keys are per-contract)
  const providers = buildProviders(ctx, buildDir);

  const compiledContract = pipe(
    CompiledContract.make(name, Contract as any),
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(buildDir),
  );

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
  });

  // deployTxData has { private, public } structure
  const txData = (deployed.deployTxData as any).public || deployed.deployTxData;
  const addr = String(txData.contractAddress);
  console.log(`  ${name} deployed at: ${addr}`);
  console.log(`    TX Hash: ${txData.txHash}`);
  console.log(`    TX ID:   ${txData.txId}`);
  console.log(`    Block:   ${txData.blockHeight}`);
  console.log(`    Status:  ${txData.status}`);
  console.log(`    Fees:    ${txData.fees?.paidFees || 'N/A'}`);

  return addr;
}

async function main() {
  console.log('=== DPO2U Self-Funding Protocol — Deploy All Contracts ===');
  console.log(`Network: ${NETWORK_ID}\n`);

  setNetworkId(NETWORK_ID);

  console.log('[1/3] Setting up wallet...');
  const ctx = await setupWallet();

  console.log('[2/3] Deploying contracts sequentially...');
  const addresses: DeployedAddresses = {};

  // Deploy order: ComplianceRegistry → PaymentGateway → FeeDistributor → AgentRegistry
  addresses.ComplianceRegistry = await deployOne('ComplianceRegistry', ctx);
  addresses.PaymentGateway = await deployOne('PaymentGateway', ctx);
  addresses.FeeDistributor = await deployOne('FeeDistributor', ctx);
  addresses.AgentRegistry = await deployOne('AgentRegistry', ctx);

  console.log('\n[3/3] Saving addresses...');
  fs.writeFileSync(ADDRESS_FILE, JSON.stringify(addresses, null, 2), 'utf-8');
  console.log(`  Addresses saved to ${ADDRESS_FILE}`);

  console.log('\n=== All 4 contracts deployed successfully ===');
  console.log(JSON.stringify(addresses, null, 2));

  await ctx.wallet.stop();
}

main().catch((err) => {
  console.error('\nDeploy failed:', err?.message || err);
  process.exit(1);
});
