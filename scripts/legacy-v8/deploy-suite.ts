/**
 * Deploy + exercise the privacy/attestation suite (+ TravelRuleGate grant/revoke) on the Midnight PREVIEW testnet ONLY (hard-coded; refuses other networks).
 * Wallet/dust/provider plumbing copied from deploy-preprod.ts.
 *   MIDNIGHT_SEED from env (never printed), PROOF_SERVER_URL (default http://127.0.0.1:6310).
 *   npx tsx scripts/deploy-travel-rule.ts
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
import * as TravelRuleGate from "../build/TravelRuleGate/contract/index.js";
import * as ConsentRegistry from "../build/ConsentRegistry/contract/index.js";
import * as DataSubjectRights from "../build/DataSubjectRights/contract/index.js";
import * as DataAuditLog from "../build/DataAuditLog/contract/index.js";
import * as SolvencyRegistry from "../build/SolvencyRegistry/contract/index.js";
import * as ComplianceRegistry from "../build/ComplianceRegistry/contract/index.js";
import * as LgpdKitRegistry from "../build/LgpdKitRegistry/contract/index.js";

// @ts-expect-error WebSocket polyfill required for wallet sync (graphql-ws) in Node
globalThis.WebSocket = WebSocket;

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
const buildPath = (name: string) => path.resolve(__dirname, '..', '..', 'build', name);

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
function ckptPaths() { const d = path.resolve(__dirname, '..', '..', `wallet-checkpoint/${getNetworkId()}`); return { shielded: path.join(d, 'shielded.json'), unshielded: path.join(d, 'unshielded.json'), dust: path.join(d, 'dust.json') }; }
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



// ── Suite: deploy each contract once, send one example tx, verify state through the indexer ──
import { createHash } from 'node:crypto';
const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');
const H = 1_628_700n; // example block height (preview tip ~1.63M)
const OUT = path.resolve(__dirname, '..', '..', 'deployment-preview-suite.json');

const ckDir = path.resolve(__dirname, '..', '..', 'wallet-checkpoint', 'preview');
async function saveCheckpoint(ctx: any) {
  try {
    fs.mkdirSync(ckDir, { recursive: true, mode: 0o700 });
    for (const [k, api] of [['shielded', ctx.wallet.shielded], ['unshielded', ctx.wallet.unshielded], ['dust', ctx.wallet.dust]] as const) {
      const blob = await (api as any).serializeState();
      fs.writeFileSync(path.join(ckDir, `${k}.json`), typeof blob === 'string' ? blob : JSON.stringify(blob), { mode: 0o600 });
    }
    console.log('[wallet] checkpoint saved');
  } catch (e: any) { console.log(`[wallet] checkpoint failed: ${e?.message ?? e}`); }
}

type Step = { label: string; call: (c: any) => Promise<any> };
type Item = { name: string; mod: any; purpose: string; steps: Step[]; check: (L: any) => Record<string, string> };
const ITEMS: Item[] = [
  { name: 'ConsentRegistry', mod: ConsentRegistry, purpose: 'LGPD/GDPR consent grant/revoke (hashed subject ids)',
    steps: [{ label: 'grantConsent(subject=demo-subject-1, purposes=7, policy=1)', call: (c) => c.callTx.grantConsent(sha('demo-subject-1'), 7n, 1n) }],
    check: (L) => ({ status: String(L.consent_status.lookup(sha('demo-subject-1'))), purposes: String(L.consent_purposes.lookup(sha('demo-subject-1'))), total_granted: String(L.total_consents_granted) }) },
  { name: 'DataSubjectRights', mod: DataSubjectRights, purpose: 'Data-subject request lifecycle (LGPD Art. 18 / GDPR 15-22)',
    steps: [
      { label: 'submitRequest(req=demo-req-1, type=1)', call: (c) => c.callTx.submitRequest(sha('demo-req-1'), 1n, H) },
      { label: 'fulfillRequest(req=demo-req-1)', call: (c) => c.callTx.fulfillRequest(sha('demo-req-1'), H + 10n) }],
    check: (L) => ({ status: String(L.request_status.lookup(sha('demo-req-1'))), total_fulfilled: String(L.total_fulfilled ?? '?') }) },
  { name: 'DataAuditLog', mod: DataAuditLog, purpose: 'Processing audit log: events, deletion requests/confirmations, breach events',
    steps: [{ label: 'logEvent(controller=demo-controller, type=1)', call: (c) => c.callTx.logEvent(sha('demo-controller'), 1n, H) }],
    check: (L) => ({ events_for_controller: String(L.events_by_controller.lookup(sha('demo-controller'))), total_events: String(L.event_count) }) },
  { name: 'SolvencyRegistry', mod: SolvencyRegistry, purpose: 'Proof of reserves: public verdict, amounts stay private (demo values, fictitious entity)',
    steps: [{ label: 'sealSolvency(entity=Example VASP (fictitious), reserves>=liabilities)', call: (c) => c.callTx.sealSolvency(sha('Example VASP Ltda (fictitious)'), sha('report-demo-1'), sha('ctx-demo-20261106'), 20261106n, 1_000_000n, 800_000n) }],
    check: (L) => ({ verdict: String(L.solvency_verdicts.lookup(sha('Example VASP Ltda (fictitious)'))), count: String(L.solvency_count) }) },
  { name: 'ComplianceRegistry', mod: ComplianceRegistry, purpose: 'Compliance attestation: score>=threshold proven, score never published (demo, fictitious company)',
    steps: [{ label: 'attestCompliance(company=Example VASP (fictitious), threshold=70, score private)', call: (c) => c.callTx.attestCompliance(sha('Example VASP Ltda (fictitious)'), sha('did:demo:agent'), sha('policy-demo'), 70n, sha('ctx-att-20261106'), 85n) },
      { label: 'attestUseCase(use_case=psav-demo-1, verdict=PASS)', call: (c) => c.callTx.attestUseCase(sha('psav-demo-1'), 1n, sha('evidence-demo-1'), sha('metadata-demo-1')) }],
    check: (L) => ({ verdict: String(L.attestation_verdicts.lookup(sha('Example VASP Ltda (fictitious)'))), count: String(L.attestation_count), usecase_verdict: String(L.usecase_verdicts.lookup(sha('evidence-demo-1'))), usecase_count: String(L.usecase_attestation_count) }) },
  { name: 'LgpdKitRegistry', mod: LgpdKitRegistry, purpose: 'LGPD kit anchor: DPIA/policy hashes + privacy score (demo, fictitious company)',
    steps: [{ label: 'registerLgpdKit(company=Example VASP (fictitious), score=88)', call: (c) => c.callTx.registerLgpdKit(sha('Example VASP Ltda (fictitious)'), sha('dpia-demo'), sha('policy-demo'), 88n, sha('did:demo:auditor')) }],
    check: (L) => ({ score: String(L.kit_privacy_scores.lookup(sha('Example VASP Ltda (fictitious)'))) }) },
];

async function main() {
  if (process.env.MIDNIGHT_NETWORK && process.env.MIDNIGHT_NETWORK !== 'preview') throw new Error('preview only');
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const entry = NETWORKS['preview'];
  setNetworkId(entry.networkId);
  const cfg = entry.cfg;
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const out: any = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { network: 'preview', contracts: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const ctx = await createWallet(cfg, seed);
  const addr = String(ctx.unshieldedKeystore.getBech32Address());
  out.wallet = addr;
  console.log(`wallet ${addr}`);
  const state: any = await waitForSync(ctx.wallet);
  await saveCheckpoint(ctx);
  const nt = ledger.unshieldedToken().raw;
  console.log(`tNIGHT ${state.unshielded?.balances?.[nt] ?? 0n}`);
  await ensureDust(ctx);
  const walletProvider = makeWalletProvider(ctx, state);

  for (const it of ITEMS) {
    if (only && !only.includes(it.name)) continue;
    const rec = (out.contracts[it.name] ??= { purpose: it.purpose, txs: [] });
    const zkPath = buildPath(it.name);
    const compiled = (CompiledContract.make(it.name, it.mod.Contract) as any).pipe(
      CompiledContract.withVacantWitnesses, (CompiledContract.withCompiledFileAssets as any)(zkPath));
    const providers = makeProviders(walletProvider, cfg, zkPath, `${it.name}-state`, addr);
    try {
      let c: any;
      if (!rec.contractAddress) {
        console.log(`[deploy] ${it.name}`);
        c = await (deployContract as any)(providers as any, { compiledContract: compiled, privateStateId: `${it.name}PS`, initialPrivateState: {} });
        const d = c.deployTxData.public;
        rec.contractAddress = d.contractAddress; rec.txs.push({ label: 'deploy', txId: d.txId, blockHeight: d.blockHeight });
        console.log(`  ${it.name}: ${d.contractAddress} tx ${d.txId} block ${d.blockHeight}`); save();
      } else {
        c = await (findDeployedContract as any)(providers as any, { contractAddress: rec.contractAddress, compiledContract: compiled, privateStateId: `${it.name}PS`, initialPrivateState: {} });
      }
      for (const st of it.steps) {
        if (rec.txs.some((t: any) => t.label === st.label)) continue;
        const r = await st.call(c); const d = r.public ?? {};
        rec.txs.push({ label: st.label, txId: d.txId, blockHeight: d.blockHeight });
        console.log(`  ${st.label}: tx ${d.txId} block ${d.blockHeight}`); save();
      }
      const L = it.mod.ledger((await (providers.publicDataProvider as any).queryContractState(rec.contractAddress)).data);
      rec.state = it.check(L); console.log(`  state ${it.name}:`, JSON.stringify(rec.state)); save();
      await saveCheckpoint(ctx);
    } catch (e: any) { rec.error = String(e?.message ?? e).slice(0, 300); console.error(`  ${it.name} FAILED: ${rec.error}`); save(); }
  }

  // TravelRuleGate on-chain disclosure: grant + revoke on the already deployed contract.
  if (!only || only.includes('TravelRuleGate')) {
    const dep = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'deployment-preview-travelrule.json'), 'utf8'));
    const rec = (out.contracts['TravelRuleGate'] ??= { purpose: 'Travel Rule gate (already deployed, MID4): disclosure grant/revoke', contractAddress: dep.contractAddress, txs: [] });
    const ownerSecret = new Uint8Array(createHash('sha256').update('dpo2u/travelrule/owner/v1').update(Buffer.from(seed, 'hex')).digest());
    const w: any = { originator_data: () => { throw new Error('n/a'); }, beneficiary_data: () => { throw new Error('n/a'); }, transfer_amount: () => { throw new Error('n/a'); }, sanctions_clear: () => { throw new Error('n/a'); }, owner_secret: (c: any) => [c.privateState, ownerSecret] };
    const zkPath = buildPath('TravelRuleGate');
    const compiled = (CompiledContract.make('TravelRuleGate', TravelRuleGate.Contract) as any).pipe((CompiledContract.withWitnesses as any)(w), (CompiledContract.withCompiledFileAssets as any)(zkPath));
    const providers = makeProviders(walletProvider, cfg, zkPath, 'TravelRuleGate-state', addr);
    try {
      const c: any = await (findDeployedContract as any)(providers as any, { contractAddress: rec.contractAddress, compiledContract: compiled, privateStateId: 'TravelRuleGatePrivateState', initialPrivateState: {} });
      const G = b32('grant-BCB-fict-001'), PASS = new Uint8Array(Buffer.from(dep.transfer_ids.pass, 'hex'));
      const steps: Step[] = [
        { label: 'grantDisclosure(BCB (fictitious), scope=name, +1h)', call: (cc) => cc.callTx.grantDisclosure(G, PASS, b32('supervisor:BCB (fictitious)'), 1n, BigInt(Math.floor(Date.now() / 1000) + 3600)) },
        { label: 'revokeDisclosure(grant-BCB-fict-001)', call: (cc) => cc.callTx.revokeDisclosure(G) }];
      for (const st of steps) {
        if (rec.txs.some((t: any) => t.label === st.label)) continue;
        const r = await st.call(c); const d = r.public ?? {};
        rec.txs.push({ label: st.label, txId: d.txId, blockHeight: d.blockHeight }); console.log(`  ${st.label}: tx ${d.txId} block ${d.blockHeight}`); save();
      }
      const L = TravelRuleGate.ledger((await (providers.publicDataProvider as any).queryContractState(rec.contractAddress)).data);
      rec.state = { grant_scope: String(L.grant_scope.lookup(G)), revoked: String(L.grant_revoked.member(G)), total_grants: String(L.total_grants) };
      console.log('  state TravelRuleGate:', JSON.stringify(rec.state)); save();
    } catch (e: any) { rec.error = String(e?.message ?? e).slice(0, 300); console.error(`  TravelRuleGate disclosure FAILED: ${rec.error}`); save(); }
  }
  try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(0);
}
main().catch((err) => { console.error('\nSuite failed:', err?.message ?? err); process.exit(1); });
