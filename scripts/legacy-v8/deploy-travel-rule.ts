/**
 * Deploy + exercise TravelRuleGate on the Midnight PREVIEW testnet ONLY (hard-coded; refuses other networks).
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


// ── TravelRuleGate: deploy + PASS/FAIL exercise ─────────────────────────────
import { createHash } from 'node:crypto';
const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');
const ZERO = new Uint8Array(32);
const party = (n: string, doc: boolean, vasp: string) => ({ name_hash: b32('name:' + n), account_hash: b32('acct:' + n), doc_hash: doc ? b32('doc:' + n) : ZERO, vasp_id: b32(vasp), salt: b32('salt:' + n) });

async function main() {
  const net = 'preview';
  if (process.env.MIDNIGHT_NETWORK && process.env.MIDNIGHT_NETWORK !== 'preview') throw new Error('preview only');
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const entry = NETWORKS[net];
  setNetworkId(entry.networkId);
  const cfg = entry.cfg;
  console.log(`TravelRuleGate deploy — ${net}; indexer ${cfg.indexer}; proof ${cfg.proofServer}`);

  // Owner secret derived from the existing wallet seed (nothing new stored, never printed).
  const ownerSecret = new Uint8Array(createHash('sha256').update('dpo2u/travelrule/owner/v1').update(Buffer.from(seed, 'hex')).digest());
  const ownerCommit = TravelRuleGate.pureCircuits.owner_commitment(ownerSecret);

  const cur: any = { o: party('orig-1', true, 'vasp:example'), b: party('benef-1', true, 'vasp:counterparty-A'), amount: 250_000n, clear: true };
  const witnesses: any = {
    originator_data: (c: any) => [c.privateState, cur.o], beneficiary_data: (c: any) => [c.privateState, cur.b],
    transfer_amount: (c: any) => [c.privateState, cur.amount], sanctions_clear: (c: any) => [c.privateState, cur.clear],
    owner_secret: (c: any) => [c.privateState, cur.secret ?? ownerSecret],
  };

  const ctx = await createWallet(cfg, seed);
  const addr = String(ctx.unshieldedKeystore.getBech32Address());
  console.log(`  wallet: ${addr}`);
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log(`  tNIGHT balance: ${state.unshielded?.balances?.[nt] ?? 0n}`);
  await ensureDust(ctx);
  const walletProvider = makeWalletProvider(ctx, state);

  const name = 'TravelRuleGate';
  const zkPath = buildPath(name);
  const compiled = (CompiledContract.make(name, TravelRuleGate.Contract) as any).pipe(
    (CompiledContract.withWitnesses as any)(witnesses), (CompiledContract.withCompiledFileAssets as any)(zkPath));
  const providers = makeProviders(walletProvider, cfg, zkPath, `${name}-state`, addr);

  // Keep earlier deployments in the record (never drop an address that is still on chain).
  const recPath = path.resolve(__dirname, '..', '..', 'deployment-preview-travelrule.json');
  const prior: any = fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, 'utf8')) : undefined;
  const previous: any[] = prior ? [...(prior.previous ?? []), ...(prior.contractAddress ? [{ ...prior, previous: undefined, note: process.env.PREVIOUS_NOTE ?? 'superseded' }] : [])] : [];
  const out: any = { network: net, wallet: addr, deployedAt: new Date().toISOString(), txs: [] as any[] };
  const rec = (label: string, r: any) => { const d = r?.public ?? r?.deployTxData?.public ?? {}; out.txs.push({ label, txId: d.txId, blockHeight: d.blockHeight }); console.log(`  ${label}: tx ${d.txId} (block ${d.blockHeight})`); };
  const save = () => fs.writeFileSync(recPath, JSON.stringify({ ...out, previous }, null, 2));

  const c: any = await (deployContract as any)(providers as any, {
    compiledContract: compiled, privateStateId: `${name}PrivateState`, initialPrivateState: {},
    args: [ownerCommit, 100_000n],
  });
  out.contractAddress = c.deployTxData.public.contractAddress;
  rec('deploy', c.deployTxData);
  console.log(`  contract: ${out.contractAddress}`);
  save();

  rec('attestVasp(counterparty-A)', await c.callTx.attestVasp(b32('vasp:counterparty-A')));
  const PASS = b32('transfer-PASS-001'), FAIL = b32('transfer-FAIL-002');
  out.transfer_ids = { pass: hx(PASS), fail: hx(FAIL) };
  // Non-owner tries to evaluate first (front-run with forged witnesses, sanctions_clear=true).
  const INTRUDER = b32('transfer-INTRUDER-003');
  out.transfer_ids.intruder = hx(INTRUDER);
  cur.secret = new Uint8Array(createHash('sha256').update('not-the-owner').digest());
  try {
    await c.callTx.evaluateTransfer(INTRUDER);
    out.non_owner_evaluate = 'UNEXPECTEDLY ACCEPTED';
  } catch (e: any) {
    out.non_owner_evaluate = `rejected: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  cur.secret = undefined;
  console.log(`  evaluateTransfer(non-owner): ${out.non_owner_evaluate}`);
  rec('evaluateTransfer(PASS case)', await c.callTx.evaluateTransfer(PASS));
  rec('releaseTransfer(PASS case)', await c.callTx.releaseTransfer(PASS));
  save();

  // FAIL case: originator without document above threshold, counterparty VASP not attested.
  cur.o = party('orig-2', false, 'vasp:example'); cur.b = party('benef-2', true, 'vasp:unknown');
  rec('evaluateTransfer(FAIL case)', await c.callTx.evaluateTransfer(FAIL));
  try {
    await c.callTx.releaseTransfer(FAIL);
    out.fail_release = 'UNEXPECTEDLY ACCEPTED';
  } catch (e: any) {
    out.fail_release = `rejected: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  console.log(`  releaseTransfer(FAIL case): ${out.fail_release}`);
  save();

  const L = TravelRuleGate.ledger((await (providers.publicDataProvider as any).queryContractState(out.contractAddress)).data);
  out.final_state = { pass_status: String(L.status.lookup(PASS)), fail_status: String(L.status.lookup(FAIL)), fail_reason: String(L.fail_reason.lookup(FAIL)), total_pass: String(L.total_pass), total_fail: String(L.total_fail), total_released: String(L.total_released), intruder_status: L.status.member(INTRUDER) ? String(L.status.lookup(INTRUDER)) : 'none' };
  console.log('  final on-chain state:', JSON.stringify(out.final_state));
  save();
  try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(0);
}
main().catch((err) => { console.error('\nDeploy failed:', err?.message ?? err); process.exit(1); });
