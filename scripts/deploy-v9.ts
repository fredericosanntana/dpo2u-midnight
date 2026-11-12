/**
 * Deploy the DPO2U contracts on ledger v9 (preview | preprod | mainnet), owner-gated.
 *
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/deploy-v9.ts --only TravelRuleGate,PsavPassport
 *   MIDNIGHT_NETWORK=preprod npx tsx scripts/deploy-v9.ts --all
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/deploy-v9.ts --dry-run --all   # no wallet, prints the plan
 *
 * Mainnet needs CONFIRM_MAINNET=yes, BLOCKFROST_PROJECT_ID, DPO2U_OWNER_SECRET and PRIVATE_STATE_PASSWORD
 * (see scripts/lib/midnight-v9.ts). Every contract gets owner_commit = owner_commitment(owner secret);
 * TravelRuleGate also takes its threshold (TRAVEL_RULE_THRESHOLD_CENTS, default 100000 = R$ 1.000,00).
 * Results go to deployment-<network>-v9.json (one entry per contract, merged with earlier runs).
 * Builds come from build/ (bash scripts/compile.sh, compactc 0.36.0).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { networkConfig, openWallet, ensureDust, makeProviders, masterSeedHex } from './lib/midnight-v9.js';
import { ownerSecret, ownerCommit } from './owner.js';

// @ts-expect-error WebSocket polyfill for graphql-ws in Node
globalThis.WebSocket = WebSocket;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Contracts and their constructor args after owner_commit. Order = deploy order. */
const CONTRACTS: Record<string, () => unknown[]> = {
  ComplianceRegistry: () => [],
  TravelRuleGate: () => [BigInt(process.env.TRAVEL_RULE_THRESHOLD_CENTS ?? '100000')],
  PsavPassport: () => [],
  ConsentRegistry: () => [],
  DataSubjectRights: () => [],
  DataAuditLog: () => [],
  SolvencyRegistry: () => [],
  LgpdKitRegistry: () => [],
  LegalSourceManifest: () => [],
  TrustStackRegistry: () => [],
  AgentRegistry: () => [],
  AgentWalletFactory: () => [],
  ComplianceEscrow: () => [],
  ComplianceEscrowV2: () => [],
  PaymentGateway: () => [],
  FeeDistributor: () => [],
};

const { values } = parseArgs({
  options: { only: { type: 'string' }, all: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
});
const names = values.all ? Object.keys(CONTRACTS) : (values.only ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!names.length) throw new Error('Pass --only A,B or --all');
for (const n of names) if (!CONTRACTS[n]) throw new Error(`Unknown contract ${n}`);

/** Every witness the contract declares (read from compact/<name>.compact): owner_secret answers,
 *  the rest refuse — deploy runs only the constructor, which reads no witness. */
function witnessesFor(name: string, secret: Uint8Array) {
  const src = fs.readFileSync(path.join(ROOT, 'compact', `${name}.compact`), 'utf8');
  const declared = [...src.matchAll(/^\s*witness\s+(\w+)\s*\(/gm)].map((m) => m[1]);
  const w: Record<string, unknown> = {};
  for (const n of declared) w[n] = () => { throw new Error(`witness ${n} is not available in deploy`); };
  w.owner_secret = (ctx: any) => [ctx.privateState, secret];
  return w;
}

async function main() {
  const net = networkConfig();
  const secret = ownerSecret(masterSeedHex());
  const OUT = path.join(ROOT, `deployment-${net.name}-v9.json`);
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { network: net.name, ledger: 'v9', contracts: {} };

  const plan = await Promise.all(names.map(async (name) => {
    const zk = path.join(ROOT, 'build', name);
    if (!fs.existsSync(path.join(zk, 'contract', 'index.js'))) throw new Error(`build/${name} missing: run bash scripts/compile.sh`);
    const mod = await import(pathToFileURL(path.join(zk, 'contract', 'index.js')).href);
    return { name, zk, mod, args: [ownerCommit(mod, secret), ...CONTRACTS[name]()] };
  }));
  console.log(`[deploy] ${net.name}: ${plan.map((p) => p.name).join(', ')}`);
  if (values['dry-run']) {
    for (const p of plan) console.log(`  ${p.name}: ${p.args.length} constructor arg(s), owner_commit ${Buffer.from(p.args[0] as Uint8Array).toString('hex').slice(0, 12)}…`);
    return;
  }

  const w = await openWallet(net);
  const dust = await ensureDust(w);
  if (dust === 0n) throw new Error('No DUST. Register NIGHT for DUST generation and wait (mainnet has no faucet).');

  for (const p of plan) {
    if (out.contracts[p.name]?.accessControl === 'owner-v1') { console.log(`  ${p.name}: already deployed at ${out.contracts[p.name].contractAddress}, skipping`); continue; }
    const providers = makeProviders(w, p.zk, `${p.name}-v9`);
    const compiled = (CompiledContract.make(p.name, p.mod.Contract) as any).pipe(
      (CompiledContract as any).withWitnesses(witnessesFor(p.name, secret)),
      (CompiledContract as any).withCompiledFileAssets(p.zk),
    );
    const c: any = await (deployContract as any)(providers, {
      compiledContract: compiled, privateStateId: `${p.name}PrivateState`, initialPrivateState: {}, args: p.args,
    });
    const d = c.deployTxData.public;
    out.contracts[p.name] = { contractAddress: String(d.contractAddress), txId: d.txId, blockHeight: d.blockHeight,
      deployedAt: new Date().toISOString(), compiler: 'compactc 0.36.0', accessControl: 'owner-v1' };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`  ${p.name}: ${d.contractAddress} (block ${d.blockHeight})`);
  }
  await w.facade.stop?.();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
