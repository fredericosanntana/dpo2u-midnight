/**
 * DPO2U Midnight — Autonomous self-funding compliance agent (MVP: Plan Phases 1+2).
 *
 * WHAT: sync the wallet ONCE, keep it warm, then drain a work queue of compliance
 * attestations, sealing each on the LIVE ComplianceRegistry (score-private ZK via
 * attestCompliance, or generic verdict via attestUseCase). Unattended and idempotent.
 *
 * SELF-FUNDING WATCHDOG (Phase 2): before every attestation, ensure DUST is above a floor;
 * if not, WAIT for it to regenerate from staked NIGHT (the agent paces itself to its own
 * fuel instead of failing). Every attestation's DUST cost is measured and written to a
 * break-even ledger — real telemetry, not the hardcoded JS simulation.
 *
 *   npx tsx scripts/agent.ts --network preview --once                    # drain once (cron-friendly)
 *   npx tsx scripts/agent.ts --network preview --watch --interval 120    # daemon, poll every 120s
 *   flags: --queue <path> (default agent-queue.json) --dust-floor <bigint> --seed <hex>
 *   env:   MIDNIGHT_SEED (hex), PROOF_SERVER_URL (default http://127.0.0.1:6300)
 *
 * NOTE: the wallet machinery below is copied from deploy-preprod.ts on purpose — agent.ts
 * stays self-contained and leaves the proven deploy script untouched. Consolidation into a
 * shared midnight-agent-core module is Plan Phase 5.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import * as ComplianceRegistry from '../build/ComplianceRegistry/contract/index.js';
import * as ComplianceEscrow from '../build/ComplianceEscrow/contract/index.js';
import * as PaymentGateway from '../build/PaymentGateway/contract/index.js';
import * as FeeDistributor from '../build/FeeDistributor/contract/index.js';
import * as TrustStackRegistry from '../build/TrustStackRegistry/contract/index.js';
import * as LegalSourceManifest from '../build/LegalSourceManifest/contract/index.js';
import * as SolvencyRegistry from '../build/SolvencyRegistry/contract/index.js';

// @ts-expect-error WebSocket polyfill required for wallet sync (graphql-ws) in Node
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const repoFile = (f: string) => path.resolve(__dirname, '..', f);
const buildPath = (name: string) => path.resolve(__dirname, '..', 'build', name);
const hhmmss = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NetCfg = { indexer: string; indexerWS: string; node: string; proofServer: string; faucetUrl?: string };
const NETWORKS: Record<string, { networkId: string; cfg: NetCfg }> = {
  preview: {
    networkId: 'preview',
    cfg: {
      indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preview.midnight.network',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
      faucetUrl: 'https://midnight-tmnight-preview.nethermind.dev/',
    },
  },
  preprod: {
    networkId: 'preprod',
    cfg: {
      indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preprod.midnight.network',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
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

// ── byte helpers ────────────────────────────────────────────────────────────
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
// Idempotent anti-replay context = sha256(org || jurisdiction || fresh-nonce). A fresh nonce
// per call means the loop is repeatable (the old hardcoded ctx reverted on the 2nd run).
function deriveContext(org: string, jurisdiction: string, nonce?: string): Uint8Array {
  const n = nonce ?? randomBytes(16).toString('hex');
  return new Uint8Array(createHash('sha256').update(`${org}||${jurisdiction}||${n}`).digest());
}

// ── Keys + wallet (midnight-js 4.x) — copied from deploy-preprod.ts ──────────
function deriveKeys(seed: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hd.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return result.keys;
}

// ── persistent wallet (SOTA gap #3): checkpoint the synced state, restore on restart, sync only
// the delta. Each facade sub-wallet exposes serializeState()/restore(serialized). Kills the
// ~13min cold resync. Checkpoints are network-scoped under wallet-checkpoint/<network>/.
function ckptDir() { return repoFile(`wallet-checkpoint/${getNetworkId()}`); }
function ckptPaths() { const d = ckptDir(); return { shielded: path.join(d, 'shielded.json'), unshielded: path.join(d, 'unshielded.json'), dust: path.join(d, 'dust.json') }; }
function hasCheckpoint() { const p = ckptPaths(); return fs.existsSync(p.shielded) && fs.existsSync(p.unshielded) && fs.existsSync(p.dust); }
// serializeState() returns a (JSON-encoded) STRING; restore() wants that SAME string — do NOT parse.
function readBlob(p: string): any { return fs.readFileSync(p, 'utf8'); }
async function writeBlob(p: string, api: any) { const blob = await api.serializeState(); fs.writeFileSync(p, typeof blob === 'string' ? blob : JSON.stringify(blob)); }
async function checkpoint(ctx: any) {
  try {
    fs.mkdirSync(ckptDir(), { recursive: true });
    const p = ckptPaths();
    await writeBlob(p.shielded, ctx.wallet.shielded);
    await writeBlob(p.unshielded, ctx.wallet.unshielded);
    await writeBlob(p.dust, ctx.wallet.dust);
    console.log(`[wallet] checkpoint saved (${hhmmss()})`);
  } catch (e: any) { console.log(`[wallet] checkpoint failed: ${e?.message ?? e}`); }
}

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
  if (restoring) console.log('[wallet] checkpoint found — restoring (delta sync only, no cold resync)');
  const wallet = await WalletFacade.init({
    configuration: walletConfig as any,
    shielded: (c: any) => restoring ? ShieldedWallet(c).restore(readBlob(p.shielded)) : ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => restoring ? UnshieldedWallet(c).restore(readBlob(p.unshielded)) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => restoring ? DustWallet(c).restore(readBlob(p.dust)) : DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

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

function progStr(p: any): string {
  if (!p || typeof p !== 'object') return '?';
  const applied = p.appliedIndex ?? p.applied ?? p.synced ?? p.processedIndex;
  const highest = p.highestIndex ?? p.highestRelevantIndex ?? p.targetIndex ?? p.total;
  if (applied !== undefined || highest !== undefined) return `${applied ?? '?'}/${highest ?? '?'}`;
  const gap = p.applyGap ?? p.sourceGap ?? p.lag;
  return gap !== undefined ? `gap:${gap}` : 'syncing';
}

async function waitForSync(wallet: any) {
  console.log('[sync] full sync incl. shielded history (give it RAM + time)...');
  const nt = ledger.unshieldedToken().raw;
  const sub = wallet.state().pipe(Rx.throttleTime(10_000)).subscribe((s: any) => {
    const sh = s.shielded?.state?.progress ?? s.shielded?.progress;
    const un = s.unshielded?.progress ?? s.unshielded?.state?.progress;
    const du = s.dust?.state?.progress ?? s.dust?.progress;
    console.log(`  [${hhmmss()}] synced=${s.isSynced} | shielded ${progStr(sh)} | unshielded ${progStr(un)} | dust ${progStr(du)} | NIGHT:${s.unshielded?.balances?.[nt] ?? 0n}`);
  });
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
  sub.unsubscribe();
  console.log('[sync] fully synced.');
  return state;
}

const dustOf = (s: any): bigint => { try { return s.dust.balance(new Date()) as bigint; } catch { return 0n; } };

async function ensureDust(ctx: any) {
  const state: any = await Rx.firstValueFrom(ctx.wallet.state());
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
    console.log(`[dust] NIGHT already registered (current balance ${dustOf(state)}).`);
  }
  // wait for dust to build toward cap (plateau) so the first attestations are funded.
  console.log('[dust] waiting for dust to build toward cap (plateau)...');
  const maxWaitMs = 8 * 60_000;
  const start = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustOf(s);
      const elapsed = Date.now() - start;
      console.log(`  [dust ${hhmmss()}] balance: ${bal} (elapsed ${Math.round(elapsed / 1000)}s)`);
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || elapsed >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  console.log(`[dust] settled at ${dustOf(await Rx.firstValueFrom(ctx.wallet.state()))}.`);
}

// Phase-2 watchdog: pace attestations to the agent's own DUST regeneration.
async function ensureDustFloor(ctx: any, floor: bigint, maxWaitMs = 10 * 60_000): Promise<bigint> {
  let bal = dustOf(await Rx.firstValueFrom(ctx.wallet.state()));
  if (bal >= floor) return bal;
  console.log(`[watchdog] DUST ${bal} < floor ${floor} — pausing for regeneration from staked NIGHT...`);
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const b = dustOf(s);
      const el = Date.now() - start;
      console.log(`  [watchdog ${hhmmss()}] DUST ${b} (need ${floor}, ${Math.round(el / 1000)}s)`);
      if (b >= floor || el >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  bal = dustOf(await Rx.firstValueFrom(ctx.wallet.state()));
  if (bal < floor) console.log(`[watchdog] WARNING: DUST still ${bal} < floor after ${Math.round(maxWaitMs / 1000)}s — NIGHT stake may be too low (top up via faucet).`);
  return bal;
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

// (B) real value release — documented working unshielded transfer, gated by the on-chain verdict.
async function transferNight(ctx: any, receiverAddress: any, amount: bigint): Promise<string> {
  const recipe = await ctx.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: ledger.unshieldedToken().raw, receiverAddress, amount }] }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await ctx.wallet.signRecipe(recipe, (p: Uint8Array) => ctx.unshieldedKeystore.signData(p));
  const tx = await ctx.wallet.finalizeRecipe(signed);
  return String(await ctx.wallet.submitTransaction(tx));
}

// ── Contract bindings + attestation ─────────────────────────────────────────
function deploymentAddress(network: string, name: string): string {
  const file = repoFile(`deployment-${network === 'undeployed' || network === 'standalone' ? 'standalone' : network}.json`);
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const addr = dep.contracts?.find((c: any) => c.name === name)?.contractAddress;
  if (!addr) throw new Error(`${name} address not found in ${file}`);
  return addr;
}

async function joinContract(walletProvider: any, cfg: NetCfg, accountId: string, name: string, mod: any, addr: string) {
  const zkPath = buildPath(name);
  const compiled = CompiledContract.make(name, mod.Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers = makeProviders(walletProvider, cfg, zkPath, `${name}-state`, accountId);
  console.log(`[agent] joining ${name} ${addr.slice(0, 16)}…`);
  return (findDeployedContract as any)(providers as any, {
    contractAddress: addr, compiledContract: compiled,
    privateStateId: `${name}PrivateState`, initialPrivateState: {},
  });
}

type QueueItem = {
  type?: 'use_case' | 'compliance' | 'escrow_create' | 'escrow_release' | 'escrow_refund' | 'trust_register' | 'legal_anchor' | 'solvency_seal';
  // use_case
  use_case_id?: string; verdict?: number; evidence_hash?: string; metadata_hash?: string;
  // compliance (score-private)
  company_id?: string; agent_did?: string; policy_cid?: string; threshold?: number; score?: number;
  org?: string; jurisdiction?: string;
  // escrow (conditional payment)
  escrow_id?: string; payer_id?: string; beneficiary_id?: string; amount?: number;
  // (B) real value release: on escrow_release, after the verdict gate passes, transfer NIGHT.
  beneficiary_address?: string; transfer_amount?: number | string;
  // (5) shared ZK trust stack + legal corpus
  stack_id?: string; stack_hash?: string; version?: number; citation_id?: string; source_hash?: string;
  // (PoR) solvency seal — reserves/liabilities are PRIVATE inputs (proven, NEVER written on-chain)
  entity_id?: string; report_cid?: string; period?: number; reserves?: number | string; liabilities?: number | string;
};

type Contracts = { cr: any; escrow: any; pg: any; fd: any; trust: any; legal: any; solvency: any };

// (2b) revenue recognition: book the per-attestation fee on-chain (PaymentGateway treasury = the
// public revenue ledger) + the 40/60 expert/auditor split (FeeDistributor). Real value-in is EARN
// (client→agent NIGHT, proven separately); this is the on-chain ACCOUNTING tied to real attestations.
async function bookRevenue(c: Contracts, fee: number): Promise<{ treasuryTx?: string; splitTx?: string }> {
  const dep = await c.pg.callTx.depositToTreasury(BigInt(fee));
  const split = await c.fd.callTx.distributeComplianceFee(40n, 60n);   // 40*3 == 60*2 invariant
  return { treasuryTx: dep?.public?.txId, splitTx: split?.public?.txId };
}
function appendRevenue(entry: any) {
  const p = repoFile('agent-revenue.json');
  const arr = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  arr.push(entry); fs.writeFileSync(p, JSON.stringify(arr, null, 2));
}

async function attestItem(c: Contracts, item: QueueItem) {
  const type = item.type ?? (item.score !== undefined ? 'compliance' : 'use_case');

  // ── ComplianceEscrow: conditional payment gated on a ZK attestation ──
  if (type === 'escrow_create') {
    const r = await c.escrow.callTx.createEscrow(
      b32(item.escrow_id!), b32(item.payer_id ?? item.org ?? 'payer'),
      b32(item.beneficiary_id ?? 'beneficiary'), BigInt(item.amount ?? 1),
      b32(item.use_case_id ?? 'usecase_v1'),
    );
    return { kind: 'escrow_create', key: item.escrow_id, public: r?.public ?? {} };
  }
  if (type === 'escrow_release') {
    const ctxBytes = deriveContext(item.org ?? 'org', item.jurisdiction ?? 'NA');
    const ev = item.evidence_hash
      ? hexToBytes32(item.evidence_hash)
      : new Uint8Array(createHash('sha256').update(`escrow-evidence||${item.escrow_id}`).digest());
    const r = await c.escrow.callTx.attestAndRelease(
      b32(item.escrow_id!), ev, BigInt(item.threshold ?? 70), ctxBytes, BigInt(item.score ?? 0),
    );
    return { kind: 'escrow_release', key: item.escrow_id, context: toHex(ctxBytes), public: r?.public ?? {} };
  }
  if (type === 'escrow_refund') {
    const r = await c.escrow.callTx.refundEscrow(b32(item.escrow_id!));
    return { kind: 'escrow_refund', key: item.escrow_id, public: r?.public ?? {} };
  }

  // ── (5) Shared ZK Trust Stack + Legal Corpus ──
  if (type === 'trust_register') {
    const r = await c.trust.callTx.registerStack(b32(item.stack_id!), hexToBytes32(item.stack_hash!), BigInt(item.version ?? 1));
    return { kind: 'trust_register', key: item.stack_id, public: r?.public ?? {} };
  }
  if (type === 'legal_anchor') {
    const r = await c.legal.callTx.anchorSource(b32(item.citation_id!), hexToBytes32(item.source_hash!), b32(item.jurisdiction ?? 'NA'));
    return { kind: 'legal_anchor', key: item.citation_id, public: r?.public ?? {} };
  }

  // ── (PoR) SolvencyRegistry: prove reserves >= liabilities WITHOUT disclosing either amount ──
  if (type === 'solvency_seal') {
    const entity = item.entity_id ?? item.org ?? 'entity';
    const ctxBytes = deriveContext(entity, `solvency:${item.period ?? 0}`);
    const rcClean = (item.report_cid ?? '').replace(/^0x/, '');
    const reportCid = /^[0-9a-fA-F]{64}$/.test(rcClean) ? hexToBytes32(item.report_cid!) : b32(item.report_cid ?? 'reserve-report-cid');
    const r = await c.solvency.callTx.sealSolvency(
      b32(entity), reportCid, ctxBytes, BigInt(item.period ?? 0),
      BigInt(item.reserves ?? 0), BigInt(item.liabilities ?? 0),
    );
    return { kind: 'solvency_seal', key: entity, context: toHex(ctxBytes), public: r?.public ?? {} };
  }

  // ── ComplianceRegistry: attestation ──
  if (type === 'compliance') {
    const org = item.org ?? item.company_id ?? 'org';
    const ctxBytes = deriveContext(org, item.jurisdiction ?? 'NA');
    const r = await c.cr.callTx.attestCompliance(
      b32(item.company_id ?? org), b32(item.agent_did ?? 'did:dpo2u:agent:001'),
      b32(item.policy_cid ?? 'bafy-policy-cid'), BigInt(item.threshold ?? 70),
      ctxBytes, BigInt(item.score ?? 0),
    );
    return { kind: 'compliance', key: item.company_id ?? org, context: toHex(ctxBytes), public: r?.public ?? {} };
  }
  const r = await c.cr.callTx.attestUseCase(
    b32(item.use_case_id ?? 'usecase_v1'), BigInt(item.verdict ?? 1),
    hexToBytes32(item.evidence_hash!), hexToBytes32(item.metadata_hash ?? item.evidence_hash!),
  );
  return { kind: 'use_case', key: item.evidence_hash, public: r?.public ?? {} };
}

// ── queue + ledger (file-backed, crash-safe drain) ──────────────────────────
function loadQueue(p: string): QueueItem[] {
  if (!fs.existsSync(p)) return [];
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.items ?? []); }
  catch (e) { console.log(`[queue] parse error: ${e}`); return []; }
}
function writeQueue(p: string, items: QueueItem[]) { fs.writeFileSync(p, JSON.stringify(items, null, 2)); }
function appendLedger(entry: any) {
  const p = repoFile('agent-ledger.json');
  const arr = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  arr.push(entry); fs.writeFileSync(p, JSON.stringify(arr, null, 2));
}

async function drainOnce(ctx: any, contracts: Contracts, queuePath: string, floor: bigint, fee: number) {
  const items = loadQueue(queuePath);
  if (items.length === 0) { console.log('[agent] queue empty.'); return 0; }
  console.log(`[agent] draining ${items.length} item(s)...`);
  let done = 0;
  while (true) {
    const remaining = loadQueue(queuePath);
    const item = remaining.shift();
    if (!item) break;
    const label = item.escrow_id ?? item.use_case_id ?? item.company_id ?? '(item)';
    try {
      await ensureDustFloor(ctx, floor);                          // Phase-2 watchdog
      const before = dustOf(await Rx.firstValueFrom(ctx.wallet.state()));
      const res = await attestItem(contracts, item);
      // (B) conditional payment: the verdict gate passed above → move real NIGHT to the beneficiary.
      let transferTx: string | null = null;
      if (res.kind === 'escrow_release' && item.beneficiary_address && item.transfer_amount != null) {
        transferTx = await transferNight(ctx, item.beneficiary_address, BigInt(item.transfer_amount));
        console.log(`  [agent] (B) released ${item.transfer_amount} NIGHT → ${String(item.beneficiary_address).slice(0, 22)}… tx ${transferTx}`);
      }
      // (2b) revenue recognition: priced attestations book the fee on-chain + the 40/60 split.
      let revenue: { treasuryTx?: string; splitTx?: string } | null = null;
      if ((res.kind === 'use_case' || res.kind === 'compliance') && fee > 0) {
        revenue = await bookRevenue(contracts, fee);
        console.log(`  [agent] (2b) revenue: fee ${fee} → PaymentGateway treasury + FeeDistributor 40/60 (tx ${revenue.treasuryTx})`);
      }
      const after = dustOf(await Rx.firstValueFrom(ctx.wallet.state()));
      const cost = before - after;
      writeQueue(queuePath, remaining);                          // drop processed (idempotent)
      appendLedger({
        ts: new Date().toISOString(), network: getNetworkId(), kind: res.kind, key: res.key,
        txId: (res.public as any).txId, blockHeight: (res.public as any).blockHeight,
        transferTx, transferAmount: transferTx ? String(item.transfer_amount) : undefined,
        dustBefore: before.toString(), dustAfter: after.toString(), dustCost: cost.toString(),
        context: (res as any).context,
      });
      if (revenue) appendRevenue({ ts: new Date().toISOString(), kind: res.kind, key: res.key, fee, treasuryTx: revenue.treasuryTx, splitTx: revenue.splitTx, dustCost: cost.toString() });
      done++;
      console.log(`[agent] ✓ ${res.kind} ${label} → tx ${(res.public as any).txId} (block ${(res.public as any).blockHeight}); DUST cost ${cost}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.log(`[agent] ✗ ${label} FAILED: ${msg}`);
      // leave the item in the queue head; abort this drain so a poison item can't spin.
      appendLedger({ ts: new Date().toISOString(), network: getNetworkId(), key: label, error: msg });
      break;
    }
  }
  console.log(`[agent] drain complete: ${done} sealed.`);
  return done;
}

async function main() {
  const { values } = parseArgs({
    options: {
      network: { type: 'string', default: process.env.MIDNIGHT_NETWORK ?? 'preview' },
      queue: { type: 'string', default: 'agent-queue.json' },
      seed: { type: 'string' },
      'dust-floor': { type: 'string', default: '1000000000000000' }, // 1e15
      once: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string', default: '120' },
      fee: { type: 'string', default: '10' },   // (2b) per-attestation fee booked to the on-chain revenue ledger (0 disables)
    },
  });
  const net = String(values.network);
  const entry = NETWORKS[net];
  if (!entry) { console.error(`Unknown network: ${net}`); process.exit(1); }
  setNetworkId(entry.networkId);
  const cfg = entry.cfg;
  const queuePath = repoFile(String(values.queue));
  const floor = BigInt(String(values['dust-floor']));
  const watch = Boolean(values.watch);
  const intervalMs = Math.max(15, Number(values.interval)) * 1000;

  console.log('='.repeat(64));
  console.log(`  DPO2U Midnight autonomous agent — ${net} (networkId=${entry.networkId})`);
  console.log(`  queue: ${queuePath} | dust-floor: ${floor} | mode: ${watch ? 'watch' : 'once'}`);
  console.log('='.repeat(64));

  const seed = String(values.seed ?? process.env.MIDNIGHT_SEED ?? '');
  if (!seed) { console.error('MIDNIGHT_SEED not set'); process.exit(1); }

  const ctx = await createWallet(cfg, seed);
  const accountId = String(ctx.unshieldedKeystore.getBech32Address());
  console.log(`  wallet: ${accountId}`);
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log(`  tNIGHT: ${state.unshielded?.balances?.[nt] ?? 0n}`);
  await ensureDust(ctx);
  await checkpoint(ctx);   // initial checkpoint after the first full sync → future restarts skip the cold resync

  const walletProvider = makeWalletProvider(ctx, state);
  const cr = await joinContract(walletProvider, cfg, accountId, 'ComplianceRegistry', ComplianceRegistry, deploymentAddress(net, 'ComplianceRegistry'));
  const escrow = await joinContract(walletProvider, cfg, accountId, 'ComplianceEscrow', ComplianceEscrow, deploymentAddress(net, 'ComplianceEscrow'));
  const pg = await joinContract(walletProvider, cfg, accountId, 'PaymentGateway', PaymentGateway, deploymentAddress(net, 'PaymentGateway'));
  const fd = await joinContract(walletProvider, cfg, accountId, 'FeeDistributor', FeeDistributor, deploymentAddress(net, 'FeeDistributor'));
  const trust = await joinContract(walletProvider, cfg, accountId, 'TrustStackRegistry', TrustStackRegistry, deploymentAddress(net, 'TrustStackRegistry'));
  const legal = await joinContract(walletProvider, cfg, accountId, 'LegalSourceManifest', LegalSourceManifest, deploymentAddress(net, 'LegalSourceManifest'));
  const solvency = await joinContract(walletProvider, cfg, accountId, 'SolvencyRegistry', SolvencyRegistry, deploymentAddress(net, 'SolvencyRegistry'));
  const contracts: Contracts = { cr, escrow, pg, fd, trust, legal, solvency };
  const fee = Number(values.fee);

  do {
    await drainOnce(ctx, contracts, queuePath, floor, fee);
    await checkpoint(ctx);                   // keep the checkpoint current so a restart stays fast
    if (watch) { console.log(`[agent] sleeping ${intervalMs / 1000}s...`); await sleep(intervalMs); }
  } while (watch);

  try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => { console.error('\nAgent failed:', err); process.exit(1); });
