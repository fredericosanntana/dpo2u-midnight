/**
 * Deploy + exercise PsavPassport on the Midnight PREVIEW testnet ONLY (hard-coded; refuses other networks).
 * NOT RUN YET: the preview wallet is shared; run it alone, after any other transaction from the same wallet has settled.
 * Wallet/dust/provider plumbing copied from deploy-preprod.ts.
 *   MIDNIGHT_SEED from env (never printed), PROOF_SERVER_URL (default http://127.0.0.1:6310).
 *   npx tsx scripts/deploy-psav-passport.ts            (DRY_RUN=1: validate inputs, no wallet, no network)
 *   Input: examples/psav-passport-example.json (scripts/gen-psav-example.ts: REAL engine evaluation, FICTITIOUS VASP).
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
import * as PsavPassport from "../build/PsavPassport/contract/index.js";

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


// ── PsavPassport: deploy + issue the example passports (real engine verdicts, fictitious VASP) ──
import { createHash, randomBytes } from 'node:crypto';
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const ZERO = new Uint8Array(32);
const YEAR = 31_536_000n;
const ORIGIN_ROWS = (e: any) => e.slots.origins.map(BigInt) as bigint[];

async function main() {
  const net = 'preview';
  if (process.env.MIDNIGHT_NETWORK && process.env.MIDNIGHT_NETWORK !== 'preview') throw new Error('preview only');
  const dry = process.env.DRY_RUN === '1';
  const examplePath = path.resolve(__dirname, '..', 'examples', 'psav-passport-example.json');
  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  if (!example.examples?.length) throw new Error('example JSON has no examples');
  const seed = process.env.MIDNIGHT_SEED;
  if (!dry && !seed) throw new Error('MIDNIGHT_SEED not set');

  // Issuer secret derived from the wallet seed (nothing new stored, never printed). In DRY_RUN a dummy is used.
  const ownerSecret = new Uint8Array(createHash('sha256').update('dpo2u/psavpassport/issuer/v1').update(Buffer.from(seed ?? 'dry-run', seed ? 'hex' : 'utf8')).digest());
  const ownerCommit = PsavPassport.pureCircuits.owner_commitment(ownerSecret);

  // Per-passport private inputs (salt random, kept ONLY in a 600 file next to the deployment, never printed).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const items = example.examples.map((e: any, i: number) => ({
    e,
    id: new Uint8Array(createHash('sha256').update(`psav-passport:${e.useCase}:${e.evidenceSha256}`).digest()),
    partnerId: new Uint8Array(createHash('sha256').update(`FICTITIOUS-VASP:${e.useCase}`).digest()),
    salt: new Uint8Array(randomBytes(32)),
    issuedAt: nowSec - 300n,
    evidence: fromHex(e.evidenceSha256),
    packHash: fromHex(e.pack.hash),
    packVersion: b32(e.pack.version),
  }));
  if (dry) {
    for (const it of items) console.log(`[dry] ${it.e.useCase}: pack ${it.e.pack.id} slots=${it.e.slots.verdicts.join('')} -> issuePassport(tier 1)`);
    console.log('[dry] inputs valid; nothing sent.');
    return;
  }

  const entry = NETWORKS[net];
  setNetworkId(entry.networkId);
  const cfg = entry.cfg;
  console.log(`PsavPassport deploy — ${net}; indexer ${cfg.indexer}; proof ${cfg.proofServer}`);

  const cur: any = { it: items[0] };
  const witnesses: any = {
    owner_secret: (c: any) => [c.privateState, ownerSecret],
    rule_origins: (c: any) => [c.privateState, ORIGIN_ROWS(cur.it.e)],
    rule_verdicts: (c: any) => [c.privateState, cur.it.e.slots.verdicts.map(BigInt)],
    partner_id: (c: any) => [c.privateState, cur.it.partnerId],
    commit_salt: (c: any) => [c.privateState, cur.it.salt],
    reviewer_sig_hash: (c: any) => [c.privateState, ZERO], // no named reviewer in the example: human rules stay REVIEW
    evidence_hash: (c: any) => [c.privateState, cur.it.evidence],
    sponsor_secret: (c: any) => [c.privateState, ZERO],
  };

  const ctx = await createWallet(cfg, seed!);
  const addr = String(ctx.unshieldedKeystore.getBech32Address());
  console.log(`  wallet: ${addr}`);
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log(`  tNIGHT balance: ${state.unshielded?.balances?.[nt] ?? 0n}`);
  await ensureDust(ctx);
  const walletProvider = makeWalletProvider(ctx, state);

  const name = 'PsavPassport';
  const zkPath = buildPath(name);
  const compiled = (CompiledContract.make(name, PsavPassport.Contract) as any).pipe(
    (CompiledContract.withWitnesses as any)(witnesses), (CompiledContract.withCompiledFileAssets as any)(zkPath));
  const providers = makeProviders(walletProvider, cfg, zkPath, `${name}-state`, addr);

  const out: any = { network: net, wallet: addr, deployedAt: new Date().toISOString(), label: example.label, txs: [] as any[], passports: [] as any[] };
  const rec = (label: string, r: any) => { const d = r?.public ?? r?.deployTxData?.public ?? {}; out.txs.push({ label, txId: d.txId, blockHeight: d.blockHeight }); console.log(`  ${label}: tx ${d.txId} (block ${d.blockHeight})`); };
  const save = () => fs.writeFileSync(path.resolve(__dirname, '..', 'deployment-preview-psav-passport.json'), JSON.stringify(out, null, 2));

  const c: any = await (deployContract as any)(providers as any, {
    compiledContract: compiled, privateStateId: `${name}PrivateState`, initialPrivateState: {},
    args: [ownerCommit],
  });
  out.contractAddress = c.deployTxData.public.contractAddress;
  rec('deploy', c.deployTxData);
  console.log(`  contract: ${out.contractAddress}`);
  save();

  // Salts/partner ids needed to open the commitments later: 600 file, outside git (see .gitignore).
  const secretsPath = path.resolve(__dirname, '..', 'deployment-preview-psav-passport.secrets.json');
  fs.writeFileSync(secretsPath, JSON.stringify(items.map((it: any) => ({ passportId: hx(it.id), partnerId: hx(it.partnerId), salt: hx(it.salt) })), null, 2), { mode: 0o600 });

  for (const it of items) {
    cur.it = it;
    rec(`issuePassport(${it.e.useCase})`, await c.callTx.issuePassport(it.id, it.packHash, it.packVersion, 1n, it.issuedAt, it.issuedAt + YEAR));
    out.passports.push({ useCase: it.e.useCase, passportId: hx(it.id), packId: it.e.pack.id, evidenceSha256: it.e.evidenceSha256 });
    save();
  }

  const L = PsavPassport.ledger((await (providers.publicDataProvider as any).queryContractState(out.contractAddress)).data);
  out.final_state = out.passports.map((p: any) => ({
    useCase: p.useCase, verdict: String(L.verdict.lookup(fromHex(p.passportId))), status: String(L.status.lookup(fromHex(p.passportId))),
    tier: String(L.tier.lookup(fromHex(p.passportId))),
  }));
  out.totals = { issued: String(L.total_issued), pass: String(L.total_pass) };
  console.log('  final on-chain state:', JSON.stringify({ passports: out.final_state, totals: out.totals }));
  save();
  try { await (ctx.wallet as any).close?.(); } catch { /* ignore */ }
  process.exit(0);
}
main().catch((err) => { console.error('\nDeploy failed:', err?.message ?? err); process.exit(1); });
