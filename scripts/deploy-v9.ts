/**
 * Deploy the DPO2U contracts on ledger v9 (preview | preprod | mainnet), owner-gated.
 *
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/deploy-v9.ts --only TravelRuleGate,PsavPassport
 *   MIDNIGHT_NETWORK=preprod npx tsx scripts/deploy-v9.ts --all
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/deploy-v9.ts --dry-run --all   # no wallet, prints the plan
 *
 * Mainnet needs CONFIRM_MAINNET=yes, BLOCKFROST_PROJECT_ID, DPO2U_OWNER_SECRET and PRIVATE_STATE_PASSWORD
 * (see scripts/lib/midnight-v9.ts). Every contract gets owner_commit = owner_commitment(owner secret).
 * TravelRuleGate (v10) also takes, in order:
 *   threshold_cents   TRAVEL_RULE_THRESHOLD_CENTS (default 100000 = R$ 1.000,00)
 *   passport          address of PsavPassport (deployed earlier in this run or in the deployment file)
 *   registry          address of ComplianceRegistry (same; must be the v10 build)
 *   self_company_id   TRAVEL_RULE_SELF_COMPANY_ID (required): the company_id this VASP is attested
 *                     under in the ComplianceRegistry (same 32-byte padding as the agent's b32)
 *   approver_commit   DPO2U_APPROVER_COMMIT, or computed from DPO2U_APPROVER_SECRET; a key apart
 *                     from the owner's (scripts/owner.ts). Testnets may derive it from the seed.
 * So PsavPassport and ComplianceRegistry deploy before TravelRuleGate.
 *
 * Per institution (one gate per client, sharing PsavPassport and ComplianceRegistry):
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/deploy-v9.ts --institution <id> --self-company-id <id> \
 *       --approver-commit <hex32> [--threshold-cents N] [--plan]
 * The approver commitment is the institution's (or DPO2U_APPROVER_COMMIT); never a secret, never derived.
 * Recorded under institutions.<id>.TravelRuleGate (scripts/lib/institutions.ts); travel-rule-v10.ts
 * selects it with --institution <id>. --plan is an alias of --dry-run.
 * Contracts whose code changed in v10 (V10_CONTRACTS) are redeployed over an older entry; the rest
 * keep the skip-if-deployed rule.
 * Results go to deployment-<network>-v9.json (one entry per contract, merged with earlier runs).
 * Each entry also records dustSpent: the wallet's DUST balance drop across that deploy. DUST keeps
 * generating while the deploy runs, so this slightly UNDER-states the fee; it is a measurement for
 * cost planning, not an exact fee.
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
import * as Rx from 'rxjs';
import { networkConfig, openWallet, ensureDust, makeProviders, masterSeedHex, dustBalance, V10_CONTRACTS, CODE_VERSION } from './lib/midnight-v9.js';
import { ownerSecret, ownerCommit, approverCommit } from './owner.js';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { institutionGateInputs, institutionGate, recordInstitutionGate } from './lib/institutions.js';

// @ts-expect-error WebSocket polyfill for graphql-ws in Node
globalThis.WebSocket = WebSocket;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ArgCtx = { net: string; secret: Uint8Array; mod: any; addressOf: (name: string) => string | undefined };

const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(s.length, 32)); return new Uint8Array(b); };
const contractRef = (addr: string) => ({ bytes: encodeContractAddress(addr) });
function linked(c: ArgCtx, name: string): { bytes: Uint8Array } {
  const a = c.addressOf(name);
  if (!a) throw new Error(`TravelRuleGate needs a current ${name} deployed first: add it to --only or deploy it earlier`);
  return contractRef(a);
}

/** Contracts and their constructor args after owner_commit. Order = deploy order. */
const CONTRACTS: Record<string, (c: ArgCtx) => unknown[]> = {
  ComplianceRegistry: () => [],
  PsavPassport: () => [],
  TravelRuleGate: (c) => {
    const self = (process.env.TRAVEL_RULE_SELF_COMPANY_ID ?? '').trim();
    if (!self) throw new Error('TRAVEL_RULE_SELF_COMPANY_ID is required for TravelRuleGate (company_id of this VASP in the ComplianceRegistry)');
    return [
      BigInt(process.env.TRAVEL_RULE_THRESHOLD_CENTS ?? '100000'),
      linked(c, 'PsavPassport'), linked(c, 'ComplianceRegistry'),
      b32(self), approverCommit(c.mod, c.net, c.secret),
    ];
  },
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

/** An entry is current when it has access control and, for contracts changed in v10, the v10 code. */
const isCurrent = (name: string, e: any) => e?.accessControl === 'owner-v1' && (!V10_CONTRACTS.has(name) || e?.codeVersion === CODE_VERSION);

const { values } = parseArgs({
  options: { only: { type: 'string' }, all: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, plan: { type: 'boolean', default: false },
    institution: { type: 'string' }, 'self-company-id': { type: 'string' }, 'approver-commit': { type: 'string' }, 'threshold-cents': { type: 'string' } },
});
const dryRun = values['dry-run'] || values.plan;
if (values.institution && (values.only || values.all)) throw new Error('--institution deploys only that institution\'s TravelRuleGate; do not combine it with --only/--all');
const order = Object.keys(CONTRACTS);
const names = (values.institution ? ['TravelRuleGate'] : values.all ? order : (values.only ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  .sort((a, b) => order.indexOf(a) - order.indexOf(b)); // dependencies first (gate after passport + registry)
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

  // Address of a contract as the gate will see it: deployed in this run, else a current entry of the file.
  const addressOf = (name: string): string | undefined => (isCurrent(name, out.contracts[name]) ? out.contracts[name].contractAddress : undefined);
  const plan = await Promise.all(names.map(async (name) => {
    const zk = path.join(ROOT, 'build', name);
    if (!fs.existsSync(path.join(zk, 'contract', 'index.js'))) throw new Error(`build/${name} missing: run bash scripts/compile.sh`);
    const mod = await import(pathToFileURL(path.join(zk, 'contract', 'index.js')).href);
    return { name, zk, mod };
  }));
  // Args are built at deploy time (the gate needs the addresses of contracts deployed just before it).
  // Institution mode: the gate's args come from the institution (its approver commitment, company id, threshold).
  const inst = values.institution ? institutionGateInputs({ institution: values.institution, selfCompanyId: values['self-company-id'], approverCommit: values['approver-commit'], thresholdCents: values['threshold-cents'] }) : undefined;
  const instLinked = (n: string) => { const a = addressOf(n); if (!a) throw new Error(`institution gate needs a current ${n} in ${path.basename(OUT)}: deploy the shared contracts first`); return contractRef(a); };
  const argsOf = (p: { name: string; mod: any }) => inst
    ? [ownerCommit(p.mod, secret), inst.thresholdCents, instLinked('PsavPassport'), instLinked('ComplianceRegistry'), b32(inst.selfCompanyId), inst.approverCommit]
    : [ownerCommit(p.mod, secret), ...CONTRACTS[p.name]({ net: net.name, secret, mod: p.mod, addressOf })];
  const existing = (name: string) => (values.institution ? institutionGate(out, values.institution) : out.contracts[name]);
  console.log(`[deploy] ${net.name}: ${plan.map((p) => p.name).join(', ')}${values.institution ? ` for institution ${values.institution}` : ''}`);
  if (dryRun) {
    for (const p of plan) {
      if (isCurrent(p.name, existing(p.name))) { console.log(`  ${p.name}: current at ${existing(p.name).contractAddress}, would skip`); continue; }
      let note: string;
      try { const a = argsOf(p); note = `${a.length} constructor arg(s), owner_commit ${Buffer.from(a[0] as Uint8Array).toString('hex').slice(0, 12)}…`; }
      catch (e: any) { note = names.includes('PsavPassport') || names.includes('ComplianceRegistry') ? `args resolved after its dependencies deploy (${e.message})` : `NOT deployable: ${e.message}`; }
      console.log(`  ${p.name}: ${note}`);
    }
    return;
  }

  const w = await openWallet(net);
  const dust = await ensureDust(w);
  if (dust === 0n) throw new Error('No DUST. Register NIGHT for DUST generation and wait (mainnet has no faucet).');

  for (const p of plan) {
    if (isCurrent(p.name, existing(p.name))) { console.log(`  ${p.name}: already deployed at ${existing(p.name).contractAddress}, skipping`); continue; }
    const args = argsOf(p);
    const dustBefore = dustBalance(await Rx.firstValueFrom(w.facade.state()));
    const t0 = Date.now();
    const providers = makeProviders(w, p.zk, values.institution ? `${p.name}-${values.institution}-v9` : `${p.name}-v9`);
    const compiled = (CompiledContract.make(p.name, p.mod.Contract) as any).pipe(
      (CompiledContract as any).withWitnesses(witnessesFor(p.name, secret)),
      (CompiledContract as any).withCompiledFileAssets(p.zk),
    );
    const c: any = await (deployContract as any)(providers, {
      compiledContract: compiled, privateStateId: `${p.name}PrivateState`, initialPrivateState: {}, args,
    });
    const d = c.deployTxData.public;
    const dustAfter = dustBalance(await Rx.firstValueFrom(w.facade.state()));
    const entry: Record<string, unknown> = { contractAddress: String(d.contractAddress), txId: d.txId, blockHeight: d.blockHeight,
      deployedAt: new Date().toISOString(), compiler: 'compactc 0.36.0', accessControl: 'owner-v1',
      ...(V10_CONTRACTS.has(p.name) ? { codeVersion: CODE_VERSION } : {}),
      ...(p.name === 'TravelRuleGate' ? { links: { PsavPassport: addressOf('PsavPassport'), ComplianceRegistry: addressOf('ComplianceRegistry') } } : {}),
      dustSpent: String(dustBefore - dustAfter), dustBefore: String(dustBefore), seconds: Math.round((Date.now() - t0) / 1000) };
    if (inst) recordInstitutionGate(out, values.institution!, { ...entry, institution: values.institution, selfCompanyId: inst.selfCompanyId,
      approverCommit: Buffer.from(inst.approverCommit).toString('hex'), thresholdCents: String(inst.thresholdCents) });
    else out.contracts[p.name] = entry;
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`  ${p.name}: ${d.contractAddress} (block ${d.blockHeight}, DUST spent ~${dustBefore - dustAfter})`);
  }
  await w.facade.stop?.();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
