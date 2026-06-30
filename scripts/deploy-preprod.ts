/**
 * Deploy DPO2U Midnight contracts to preprod (or standalone), midnight-js 4.x / ledger-v8.
 * Rewritten 2026-05-29 for the current Midnight generation (was midnight-js 3.2.0 / ledger-v7,
 * which silently stalled syncing the v8 preprod chain).
 *
 *   npx tsx scripts/deploy-preprod.ts --network preprod --all   # deploy all 5
 *   npx tsx scripts/deploy-preprod.ts --network preprod         # AgentRegistry only
 *   flags: --seed <hex> (default $MIDNIGHT_SEED) --faucet --join <addr>
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore, PublicKey, UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import * as AgentRegistry from '../build/AgentRegistry/contract/index.js';
import * as AgentWalletFactory from '../build/AgentWalletFactory/contract/index.js';
import * as ComplianceRegistry from '../build/ComplianceRegistry/contract/index.js';
import * as FeeDistributor from '../build/FeeDistributor/contract/index.js';
import * as PaymentGateway from '../build/PaymentGateway/contract/index.js';
import * as LgpdKitRegistry from '../build/LgpdKitRegistry/contract/index.js';
import * as ConsentRegistry from '../build/ConsentRegistry/contract/index.js';
import * as DataAuditLog from '../build/DataAuditLog/contract/index.js';
import * as DataSubjectRights from '../build/DataSubjectRights/contract/index.js';
import * as ComplianceEscrow from '../build/ComplianceEscrow/contract/index.js';
import * as TrustStackRegistry from '../build/TrustStackRegistry/contract/index.js';
import * as LegalSourceManifest from '../build/LegalSourceManifest/contract/index.js';

// @ts-expect-error WebSocket polyfill required for wallet sync (graphql-ws) in Node
globalThis.WebSocket = WebSocket;

const ALL_CONTRACTS: Array<{ name: string; mod: any }> = [
  { name: 'AgentRegistry', mod: AgentRegistry },
  { name: 'AgentWalletFactory', mod: AgentWalletFactory },
  { name: 'ComplianceRegistry', mod: ComplianceRegistry },
  { name: 'FeeDistributor', mod: FeeDistributor },
  { name: 'PaymentGateway', mod: PaymentGateway },
  { name: 'LgpdKitRegistry', mod: LgpdKitRegistry },
  { name: 'ConsentRegistry', mod: ConsentRegistry },
  { name: 'DataAuditLog', mod: DataAuditLog },
  { name: 'DataSubjectRights', mod: DataSubjectRights },
  { name: 'ComplianceEscrow', mod: ComplianceEscrow },
  { name: 'TrustStackRegistry', mod: TrustStackRegistry },
  { name: 'LegalSourceManifest', mod: LegalSourceManifest },
];

type NetCfg = { indexer: string; indexerWS: string; node: string; proofServer: string; faucetUrl?: string };
const NETWORKS: Record<string, { networkId: string; cfg: NetCfg }> = {
  preprod: {
    networkId: 'preprod',
    cfg: {
      indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preprod.midnight.network',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
      faucetUrl: 'https://faucet.preprod.midnight.network/api/request-tokens',
    },
  },
  preview: {
    networkId: 'preview',
    cfg: {
      indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preview.midnight.network',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
      faucetUrl: 'https://faucet.preview.midnight.network/api/request-tokens',
    },
  },
  standalone: {
    networkId: 'undeployed',
    cfg: {
      indexer: 'http://localhost:8088/api/v4/graphql',
      indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
      node: 'ws://localhost:9944',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
    },
  },
};

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const buildPath = (name: string) => path.resolve(__dirname, '..', 'build', name);

// ── Keys + wallet (midnight-js 4.x) ────────────────────────────────────────
function deriveKeys(seed: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hd.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return result.keys;
}

// Reuse the daemon's persistent wallet checkpoint (SOTA #3) so deploys skip the ~13min cold sync too.
// Read-only: the agent daemon owns/updates the checkpoint; deploy just restores from it.
function ckptPaths() { const d = path.resolve(__dirname, '..', `wallet-checkpoint/${getNetworkId()}`); return { shielded: path.join(d, 'shielded.json'), unshielded: path.join(d, 'unshielded.json'), dust: path.join(d, 'dust.json') }; }
function hasCheckpoint() { const p = ckptPaths(); return fs.existsSync(p.shielded) && fs.existsSync(p.unshielded) && fs.existsSync(p.dust); }
const readBlob = (p: string) => fs.readFileSync(p, 'utf8');   // serializeState() is a JSON STRING — pass raw to restore()

async function createWallet(cfg: NetCfg, seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const walletConfig = {
    networkId,
    indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
    provingServerUrl: new URL(cfg.proofServer),
    relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const restoring = hasCheckpoint();
  const p = ckptPaths();
  if (restoring) console.log('[wallet] checkpoint found — restoring (delta sync only)');
  const wallet = await WalletFacade.init({
    configuration: walletConfig as any,
    shielded: (c: any) => restoring ? ShieldedWallet(c).restore(readBlob(p.shielded)) : ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => restoring ? UnshieldedWallet(c).restore(readBlob(p.unshielded)) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => restoring ? DustWallet(c).restore(readBlob(p.dust)) : DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// Sign unshielded transaction intents (required by the 4.x unproven-tx workflow).
function signTransactionIntents(
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => any,
  proofMarker: 'proof' | 'pre-proof',
): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize('signature', proofMarker, 'pre-binding', intent.serialize());
    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature);
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature);
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

// Render a per-domain sync progress as applied/highest so we can SEE convergence
// (is the gap shrinking?) instead of an opaque "syncing". Defensive: field names vary
// across the shielded/unshielded/dust wallets, so probe the common ones.
function progStr(p: any): string {
  if (!p || typeof p !== 'object') return '?';
  const applied = p.appliedIndex ?? p.applied ?? p.synced ?? p.processedIndex;
  const highest = p.highestIndex ?? p.highestRelevantIndex ?? p.targetIndex ?? p.total;
  if (applied !== undefined || highest !== undefined) return `${applied ?? '?'}/${highest ?? '?'}`;
  const gap = p.applyGap ?? p.sourceGap ?? p.lag;
  return gap !== undefined ? `gap:${gap}` : 'syncing';
}

async function waitForSync(wallet: any) {
  console.log('[sync] full sync incl. shielded history (memory-heavy — give it RAM + time)...');
  const nt = ledger.unshieldedToken().raw;
  const sub = wallet.state().pipe(Rx.throttleTime(10_000)).subscribe((s: any) => {
    const sh = s.shielded?.state?.progress ?? s.shielded?.progress;
    const un = s.unshielded?.progress ?? s.unshielded?.state?.progress;
    const du = s.dust?.state?.progress ?? s.dust?.progress;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] synced=${s.isSynced} | shielded ${progStr(sh)} | unshielded ${progStr(un)} | dust ${progStr(du)} | NIGHT:${s.unshielded?.balances?.[nt] ?? 0n} dust:${s.dust?.availableCoins?.length ?? 0}`);
  });
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
  sub.unsubscribe();
  console.log('[sync] fully synced.');
  return state;
}

// DUST: faucet gives only unshielded NIGHT (dust:0). Register NIGHT UTxOs for dust generation,
// then wait for dust to accrue before any fee-paying tx. Canonical headless flow (per IOG mentor):
//   register → finalizeRecipe → submitTransaction → wait until dust.balance(now) > 0n.
async function ensureDust(ctx: any) {
  const dustOf = (s: any) => { try { return s.dust.balance(new Date()) as bigint; } catch { return 0n; } };
  const state: any = await Rx.firstValueFrom(ctx.wallet.state());

  // Register any NIGHT UTxOs not yet generating dust (idempotent — safe across re-runs).
  const nightUtxos = (state.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (nightUtxos.length > 0) {
    console.log(`[dust] registering ${nightUtxos.length} NIGHT UTxO(s) for dust generation...`);
    const vk = ctx.unshieldedKeystore.getPublicKey();
    const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(nightUtxos, vk, signFn);
    const tx = await ctx.wallet.finalizeRecipe(recipe);
    const txId = await ctx.wallet.submitTransaction(tx);
    console.log(`[dust] registration tx submitted: ${txId}`);
  } else {
    console.log(`[dust] NIGHT already registered for dust generation (current balance ${dustOf(state)}).`);
  }

  // Dust accrues GRADUALLY toward a cap proportional to registered NIGHT. Deploying at the first
  // wei of dust (old `> 0n` gate) starves the 2nd+ tx → "Insufficient Funds: could not balance
  // dust". Wait until the balance PLATEAUS (≈cap) so all 9 deploys are covered. Bounded by maxWait.
  console.log('[dust] waiting for dust to build toward cap (plateau detection)...');
  const maxWaitMs = 8 * 60_000;
  const start = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustOf(s);
      const elapsed = Date.now() - start;
      console.log(`  [dust ${new Date().toISOString().slice(11, 19)}] balance: ${bal} (elapsed ${Math.round(elapsed / 1000)}s)`);
      // plateau = balance > 0 and grew < ~0.5% since the previous sample, twice consecutively.
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || elapsed >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  const finalState: any = await Rx.firstValueFrom(ctx.wallet.state());
  console.log(`[dust] dust settled at ${dustOf(finalState)} — proceeding to deploy.`);
}

function makeWalletProvider(ctx: Awaited<ReturnType<typeof createWallet>>, state: any) {
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx) as any,
  };
}

function makeProviders(walletProvider: any, cfg: NetCfg, zkPath: string, storeName: string, accountId: string) {
  const zkConfigProvider = new NodeZkConfigProvider(zkPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: storeName,
      // midnight-js 4.1.1: the private-state store takes a password provider (>=16 chars) + accountId
      // (the config union is passwordProvider-XOR-walletProvider; walletProvider is supplied at the
      // providers top level below, not here).
      privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD ?? 'dpo2u-local-dev-private-state-pw-2026',
      accountId,
    }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function deployOne(walletProvider: any, cfg: NetCfg, entry: { name: string; mod: any }, accountId: string) {
  const zkPath = buildPath(entry.name);
  const compiled = CompiledContract.make(entry.name, entry.mod.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers = makeProviders(walletProvider, cfg, zkPath, `${entry.name}-state`, accountId);
  console.log(`\n[deploy] ${entry.name} — proving + submitting...`);
  const contract = await (deployContract as any)(providers as any, {
    compiledContract: compiled,
    privateStateId: `${entry.name}PrivateState`,
    initialPrivateState: {},
  });
  const d = contract.deployTxData.public;
  console.log(`  ${entry.name}: ${d.contractAddress} (block ${d.blockHeight}, tx ${d.txId})`);
  return { name: entry.name, contractAddress: d.contractAddress, blockHeight: d.blockHeight, txId: d.txId };
}

// --loop: exercise the full self-funding cycle on the already-deployed contracts (callTx).
function b32(s: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(buf, 0, 0, Math.min(s.length, 32));
  return new Uint8Array(buf);
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`hexToBytes32: expected 64 hex chars, got ${clean.length}`);
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

// --attest: generic use-case attestation (the gateway/MCP dual-chain path). Joins the deployed
// ComplianceRegistry and calls attestUseCase(use_case_id, verdict, evidence_hash, metadata_hash).
// Prints a single machine-readable line `ATTEST_RESULT {json}` for the gateway MidnightDriver to parse.
async function runAttest(walletProvider: any, cfg: NetCfg, accountId: string, a: {
  useCaseId: string; verdict: number; evidenceHash: string; metadataHash: string;
}) {
  const dep = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', `deployment-${getNetworkId() === 'undeployed' ? 'standalone' : 'preprod'}.json`), 'utf8'));
  const addr = dep.contracts.find((c: any) => c.name === 'ComplianceRegistry')?.contractAddress;
  if (!addr) throw new Error('ComplianceRegistry not found in deployment json');
  const entry = ALL_CONTRACTS.find((c) => c.name === 'ComplianceRegistry')!;
  const zkPath = buildPath('ComplianceRegistry');
  const compiled = CompiledContract.make('ComplianceRegistry', entry.mod.Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers = makeProviders(walletProvider, cfg, zkPath, 'ComplianceRegistry-state', accountId);
  const cr: any = await (findDeployedContract as any)(providers as any, {
    contractAddress: addr, compiledContract: compiled,
    privateStateId: 'ComplianceRegistryPrivateState', initialPrivateState: {},
  });
  const r = await cr.callTx.attestUseCase(
    b32(a.useCaseId), BigInt(a.verdict), hexToBytes32(a.evidenceHash), hexToBytes32(a.metadataHash),
  );
  const d = r?.public ?? {};
  console.log('ATTEST_RESULT ' + JSON.stringify({
    txId: d.txId, blockHeight: d.blockHeight, contractAddress: addr,
  }));
}

async function runLoop(walletProvider: any, cfg: NetCfg, accountId: string) {
  const dep = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', `deployment-${getNetworkId() === 'undeployed' ? 'standalone' : 'preprod'}.json`), 'utf8'));
  const addrOf: Record<string, string> = {};
  for (const c of dep.contracts) if (c.contractAddress) addrOf[c.name] = c.contractAddress;

  async function join(name: string) {
    const entry = ALL_CONTRACTS.find((c) => c.name === name)!;
    const zkPath = buildPath(name);
    const compiled = CompiledContract.make(name, entry.mod.Contract).pipe(
      CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath),
    );
    const providers = makeProviders(walletProvider, cfg, zkPath, `${name}-state`, accountId);
    return (findDeployedContract as any)(providers as any, {
      contractAddress: addrOf[name], compiledContract: compiled,
      privateStateId: `${name}PrivateState`, initialPrivateState: {},
    });
  }
  const tx = (label: string, r: any) => console.log(`  [loop] ${label}: tx ${r?.public?.txId ?? r?.txId} (block ${r?.public?.blockHeight ?? '?'})`);

  const agentDid = b32('did:dpo2u:agent:001');
  const company = b32('acme-corp-loop');
  const ctx32 = b32('ctx:acme||LGPD||nonce-loop-1');

  console.log('\n=== SELF-FUNDING LOOP (on-chain) ===');
  console.log('[loop] 1/5 AgentRegistry.registerAgent (agent identity on-chain)');
  const ar: any = await join('AgentRegistry');
  tx('registerAgent', await ar.callTx.registerAgent(agentDid, b32('compliance-agent')));

  console.log('[loop] 2/5 AgentWalletFactory.registerAgent (bind agent -> wallet)');
  const awf: any = await join('AgentWalletFactory');
  tx('registerAgent', await awf.callTx.registerAgent(agentDid, b32(accountId)));

  console.log('[loop] 3/5 PaymentGateway: stake $NIGHT + deposit to treasury');
  const pg: any = await join('PaymentGateway');
  tx('stakeTokens(1000)', await pg.callTx.stakeTokens(1000n));
  tx('depositToTreasury(500)', await pg.callTx.depositToTreasury(500n));

  console.log('[loop] 4/5 ComplianceRegistry.attestCompliance (ZK: score 85 private, threshold 70 public)');
  const cr: any = await join('ComplianceRegistry');
  tx('attestCompliance', await cr.callTx.attestCompliance(company, agentDid, b32('bafy-policy-cid'), 70n, ctx32, 85n));

  console.log('[loop] 5/5 FeeDistributor.distributeComplianceFee (40/60 split)');
  const fd: any = await join('FeeDistributor');
  tx('distributeComplianceFee(40,60)', await fd.callTx.distributeComplianceFee(40n, 60n));

  console.log('=== LOOP COMPLETE — stake -> attest(ZK) -> fee-split exercised on-chain ===');
}

async function requestFaucet(url: string, address: string) {
  try {
    console.log('[faucet] requesting tNIGHT...');
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }),
    });
    console.log(res.ok ? '  faucet OK' : `  faucet ${res.status}: ${await res.text()}`);
  } catch (e) { console.log(`  faucet error: ${e}`); }
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      network: { type: 'string', default: process.env.MIDNIGHT_NETWORK ?? 'preprod' },
      join: { type: 'string' },
      faucet: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      only: { type: 'string' },
      loop: { type: 'boolean', default: false },
      attest: { type: 'boolean', default: false },
      'use-case-id': { type: 'string' },
      verdict: { type: 'string' },
      'evidence-hash': { type: 'string' },
      'metadata-hash': { type: 'string' },
    },
  });
  const net = String(values.network);
  const entry = NETWORKS[net];
  if (!entry) { console.error(`Unknown network: ${net}`); process.exit(1); }
  setNetworkId(entry.networkId);
  const cfg = entry.cfg;

  console.log('='.repeat(64));
  console.log(`  DPO2U Midnight deploy — ${net} (networkId=${entry.networkId})`);
  console.log(`  indexer: ${cfg.indexer}`);
  console.log(`  proof:   ${cfg.proofServer}`);
  console.log('='.repeat(64));

  const seed = values.seed ?? process.env.MIDNIGHT_SEED ?? toHex(Buffer.from(generateRandomSeed()));
  const ctx = await createWallet(cfg, seed);
  const addr = String(ctx.unshieldedKeystore.getBech32Address());
  console.log(`  wallet: ${addr}`);

  if (values.faucet && cfg.faucetUrl) await requestFaucet(cfg.faucetUrl, addr);

  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log(`  tNIGHT balance: ${state.unshielded?.balances?.[nt] ?? 0n}`);
  await ensureDust(ctx);
  const walletProvider = makeWalletProvider(ctx, state);

  if (values.attest) {
    await runAttest(walletProvider, cfg, addr, {
      useCaseId: String(values['use-case-id'] ?? ''),
      verdict: Number(values.verdict ?? '1'),
      evidenceHash: String(values['evidence-hash'] ?? ''),
      metadataHash: String(values['metadata-hash'] ?? ''),
    });
    try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
    process.exit(0);
  }

  if (values.loop) {
    await runLoop(walletProvider, cfg, addr);
    try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
    process.exit(0);
  }

  const onlyNames = values.only ? String(values.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const contracts = onlyNames
    ? ALL_CONTRACTS.filter((c) => onlyNames.includes(c.name))
    : values.all ? ALL_CONTRACTS : [ALL_CONTRACTS[0]];
  if (contracts.length === 0) { console.error(`--only: unknown contract(s) "${values.only}"`); process.exit(1); }
  const results: any[] = [];
  for (const c of contracts) {
    try { results.push(await deployOne(walletProvider, cfg, c, addr)); }
    catch (e: any) { console.error(`  ${c.name} FAILED: ${e?.message ?? e}`); results.push({ name: c.name, error: String(e?.message ?? e) }); }
  }

  const ok = results.filter((r) => r.contractAddress);
  console.log('\n' + '='.repeat(64));
  console.log(`  SUMMARY — ${ok.length}/${contracts.length} deployed on ${net}`);
  for (const r of results) console.log(r.contractAddress ? `  OK    ${r.name}: ${r.contractAddress}` : `  FAIL  ${r.name}: ${r.error}`);
  console.log('='.repeat(64));

  const outPath = path.resolve(__dirname, '..', `deployment-${net}.json`);
  // Merge with any existing deployment so a partial deploy (--only) does not clobber the rest.
  let existing: any = { contracts: [] };
  try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* no prior file */ }
  const byName = new Map<string, any>((existing.contracts ?? []).map((c: any) => [c.name, c]));
  for (const r of results) byName.set(r.name, r);
  fs.writeFileSync(outPath, JSON.stringify({
    network: net, networkId: entry.networkId, walletAddress: addr,
    deployedAt: new Date().toISOString(), contracts: Array.from(byName.values()),
  }, null, 2));
  console.log(`  saved: ${outPath} (${byName.size} contracts total)`);

  try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(ok.length === contracts.length ? 0 : 2);
}

main().catch((err) => { console.error('\nDeploy failed:', err); process.exit(1); });
