/**
 * DPO2U Paymaster — non-custodial DUST-as-a-Service relay/delegation module.
 *
 * The economic thesis: DUST is non-transferable by protocol, so you cannot SELL DUST.
 * But (a) a NIGHT holder can REDIRECT the DUST their NIGHT generates to the controller's
 * dust address while KEEPING custody of the NIGHT, and (b) the controller can spend that
 * pooled DUST to pay fees for compliance attestations ordered by big-players — selling
 * SPONSORED CAPACITY (billed in NIGHT/USDC), not the resource itself.
 *
 * This module is the reusable core (wallet machinery + the three paymaster legs). It is
 * imported by scripts/paymaster-demo.ts (the E2E) and usable standalone via the CLIs below.
 *
 * Wallet machinery is copied from agent.ts / client-pays.ts on purpose (repo convention:
 * each script stays self-contained; the proven deploy/agent scripts stay untouched).
 *
 * CLIs:
 *   # print the controller's dust address (the receiver a holder delegates to)
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts controller-dust --account 0
 *
 *   # holder (account N) redirects DUST generation to the controller's dust address, KEEPS NIGHT
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts delegate --holder-account 1 --controller-dust <mn_dust_preview1...>
 *
 *   # holder revokes the delegation (DUST generation returns to the holder)
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts deregister --holder-account 1
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m, DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

// @ts-expect-error WS polyfill required for wallet sync in Node
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const repoFile = (f: string) => path.resolve(__dirname, '..', f);
const buildPath = (name: string) => path.resolve(__dirname, '..', 'build', name);
export const hhmmss = () => new Date().toISOString().slice(11, 19);

export type NetCfg = { indexer: string; indexerWS: string; node: string; proofServer: string };
export const NETWORKS: Record<string, { networkId: string; cfg: NetCfg }> = {
  preview: {
    networkId: 'preview',
    cfg: {
      indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preview.midnight.network',
      proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
    },
  },
};

// ── ids: opaque, deterministic Bytes<32> from any address string (privacy-preserving) ──
export function idFromString(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

// ── keys + wallet (parameterized by HD account so we can run holder/controller/big-player) ──
function deriveKeys(seed: string, account: number) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const r = hd.hdWallet.selectAccount(account)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return r.keys;
}

export type WalletCtx = Awaited<ReturnType<typeof createWallet>>;

export async function createWallet(cfg: NetCfg, seed: string, account: number) {
  const keys = deriveKeys(seed, account);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const wallet = await WalletFacade.init({
    configuration: {
      networkId,
      indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
      provingServerUrl: new URL(cfg.proofServer),
      relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    } as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, account };
}

export const dustOf = (s: any): bigint => { try { return s.dust.balance(new Date()) as bigint; } catch { return 0n; } };
export const nightOf = (s: any): bigint => s.unshielded?.balances?.[ledger.unshieldedToken().raw] ?? 0n;

export async function waitForSync(wallet: any, label = 'wallet') {
  console.log(`[sync] ${label}: full sync...`);
  const sub = wallet.state().pipe(Rx.throttleTime(10_000)).subscribe((s: any) =>
    console.log(`  [${hhmmss()}] ${label} synced=${s.isSynced} NIGHT:${nightOf(s)} DUST:${dustOf(s)}`));
  const st = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
  sub.unsubscribe();
  console.log(`[sync] ${label} fully synced.`);
  return st;
}

// ── dust address serialization (the receiver a holder delegates to) ──
export async function dustAddressString(ctx: WalletCtx): Promise<string> {
  const a = await ctx.wallet.dust.getAddress();
  return MidnightBech32m.encode(getNetworkId() as any, a as any).toString();
}
export function parseDustAddress(bech32: string): DustAddress {
  return (DustAddress as any).codec.decode(getNetworkId() as any, MidnightBech32m.parse(bech32));
}

// ── LEG 1 — non-custodial delegation: holder redirects DUST generation to the controller ──
// The holder signs the registration (they OWN the NIGHT). The 4th arg redirects the generated
// DUST to `controllerDustAddress`. The NIGHT never leaves the holder's wallet; revocable below.
export async function delegateDustGeneration(holder: WalletCtx, controllerDustAddress: DustAddress): Promise<string | null> {
  const state: any = await Rx.firstValueFrom(holder.wallet.state());
  const nightUtxos = (state.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (nightUtxos.length === 0) { console.log('[delegate] no unregistered NIGHT UTxOs (already delegated or zero balance).'); return null; }
  console.log(`[delegate] redirecting DUST from ${nightUtxos.length} NIGHT UTxO(s) → controller dust address (holder keeps NIGHT)...`);
  const vk = holder.unshieldedKeystore.getPublicKey();
  const signFn = (p: Uint8Array) => holder.unshieldedKeystore.signData(p);
  const recipe = await holder.wallet.registerNightUtxosForDustGeneration(nightUtxos, vk, signFn, controllerDustAddress);
  const tx = await holder.wallet.finalizeRecipe(recipe);
  const txId = String(await holder.wallet.submitTransaction(tx));
  console.log(`[delegate] delegation tx submitted: ${txId}`);
  return txId;
}

// Revocation — DUST generation returns to the holder's own dust address (omit receiver arg).
export async function deregisterDelegation(holder: WalletCtx): Promise<string | null> {
  const state: any = await Rx.firstValueFrom(holder.wallet.state());
  const registered = (state.unshielded.availableCoins ?? []).filter((u: any) => u.meta?.registeredForDustGeneration);
  if (registered.length === 0) { console.log('[deregister] nothing registered.'); return null; }
  const vk = holder.unshieldedKeystore.getPublicKey();
  const signFn = (p: Uint8Array) => holder.unshieldedKeystore.signData(p);
  const recipe = await holder.wallet.deregisterFromDustGeneration(registered, vk, signFn);
  const tx = await holder.wallet.finalizeRecipe(recipe);
  const txId = String(await holder.wallet.submitTransaction(tx));
  console.log(`[deregister] delegation revoked: ${txId}`);
  return txId;
}

// Wait for the controller's DUST to build from delegated NIGHT (plateau toward cap ~1 week; a
// usable floor arrives in minutes). Reused from agent.ts ensureDust plateau detection.
export async function waitForDustPlateau(ctx: WalletCtx, maxWaitMs = 8 * 60_000) {
  console.log('[dust] waiting for DUST to build toward cap (plateau)...');
  const start = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustOf(s);
      console.log(`  [dust ${hhmmss()}] balance: ${bal} (${Math.round((Date.now() - start) / 1000)}s)`);
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || Date.now() - start >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  console.log(`[dust] settled at ${dustOf(await Rx.firstValueFrom(ctx.wallet.state()))}.`);
}

// ── contract wiring (copied from agent.ts) — sign + balance + submit for on-chain records ──
function signTransactionIntents(tx: { intents?: Map<number, any> }, signFn: (p: Uint8Array) => any, proofMarker: 'proof' | 'pre-proof') {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize('signature', proofMarker, 'pre-binding', intent.serialize());
    const sig = signFn(cloned.signatureData(segment));
    if (cloned.fallibleUnshieldedOffer)
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(cloned.fallibleUnshieldedOffer.inputs.map((_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? sig));
    if (cloned.guaranteedUnshieldedOffer)
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(cloned.guaranteedUnshieldedOffer.inputs.map((_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? sig));
    tx.intents.set(segment, cloned);
  }
}

export function makeWalletProvider(ctx: WalletCtx, state: any) {
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signFn = (p: Uint8Array) => ctx.unshieldedKeystore.signData(p);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx) as any,
  };
}

export function makeProviders(walletProvider: any, cfg: NetCfg, zkPath: string, storeName: string, accountId: string) {
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

export function deploymentAddress(network: string, name: string): string {
  const file = repoFile(`deployment-${network === 'undeployed' || network === 'standalone' ? 'standalone' : network}.json`);
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const addr = dep.contracts?.find((c: any) => c.name === name)?.contractAddress;
  if (!addr) throw new Error(`${name} address not found in ${file} — deploy the paymaster increment first`);
  return addr;
}

export async function joinContract(walletProvider: any, cfg: NetCfg, accountId: string, name: string, mod: any) {
  const zkPath = buildPath(name);
  const compiled = CompiledContract.make(name, mod.Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath));
  const providers = makeProviders(walletProvider, cfg, zkPath, `${name}-state`, accountId);
  const addr = deploymentAddress(getNetworkId(), name);
  console.log(`[join] ${name} ${addr.slice(0, 16)}…`);
  return (findDeployedContract as any)(providers as any, {
    contractAddress: addr, compiledContract: compiled,
    privateStateId: `${name}PrivateState`, initialPrivateState: {},
  });
}

// ── CLI ──
async function cli() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', default: '0' },
      'holder-account': { type: 'string', default: '1' },
      'controller-dust': { type: 'string' },
    },
    allowPositionals: true,
  });
  const cmd = process.argv[2];
  setNetworkId('preview');
  const cfg = NETWORKS.preview.cfg;
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');

  if (cmd === 'controller-dust') {
    const ctrl = await createWallet(cfg, seed, Number(values.account));
    await waitForSync(ctrl.wallet, 'controller');
    console.log('\nController dust address (delegate to this):');
    console.log('  ' + await dustAddressString(ctrl));
    console.log('  unshielded: ' + String(ctrl.unshieldedKeystore.getBech32Address()));
    process.exit(0);
  }
  if (cmd === 'delegate') {
    if (!values['controller-dust']) throw new Error('--controller-dust <mn_dust_preview1...> required');
    const holder = await createWallet(cfg, seed, Number(values['holder-account']));
    console.log('holder:', String(holder.unshieldedKeystore.getBech32Address()));
    await waitForSync(holder.wallet, 'holder');
    const before = nightOf(await Rx.firstValueFrom(holder.wallet.state()));
    await delegateDustGeneration(holder, parseDustAddress(String(values['controller-dust'])));
    const after = nightOf(await Rx.firstValueFrom(holder.wallet.state()));
    console.log(`\n✅ delegated. Holder NIGHT before=${before} after=${after} (custody retained; delta is only the tiny fee).`);
    process.exit(0);
  }
  if (cmd === 'deregister') {
    const holder = await createWallet(cfg, seed, Number(values['holder-account']));
    await waitForSync(holder.wallet, 'holder');
    await deregisterDelegation(holder);
    process.exit(0);
  }
  console.error('Usage: dust-relay.ts <controller-dust|delegate|deregister> [flags]');
  process.exit(1);
}

// Run as CLI only when invoked directly (not when imported by paymaster-demo.ts).
if (process.argv[1] && process.argv[1].endsWith('dust-relay.ts')) {
  cli().catch((e) => { console.error('\ndust-relay failed:', e?.stack ?? e); process.exit(1); });
}
