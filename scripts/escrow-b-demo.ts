/**
 * C2 path (B) — REAL NIGHT moves, gated on the on-chain ZK verdict, via custodial transfer.
 * Joins the live V1 ComplianceEscrow, does createEscrow → attestAndRelease (ZK gate, marks RELEASED
 * on-chain), THEN executes a real unshielded transferTransaction of NIGHT to the beneficiary.
 * The transfer is the documented, working path (no error 192). Self-transfer here (beneficiary = us)
 * just proves the wiring; in production the beneficiary is a third party.
 *
 *   MIDNIGHT_SEED=<hex> NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/escrow-b-demo.ts
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ComplianceEscrow from '../build/ComplianceEscrow/contract/index.js';

// @ts-expect-error WS polyfill
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const buildPath = (n: string) => path.resolve(__dirname, '..', 'build', n);
const hhmmss = () => new Date().toISOString().slice(11, 19);
const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(s.length, 32)); return new Uint8Array(b); };
const sha32 = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

const cfg = {
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
};
const ESCROW_V1 = 'c7f6b2243c09454f270d95e23cde7ed01ed167e60675cab07449ea2d5436a6b9';

function deriveKeys(seed: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear(); return r.keys;
}
async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const walletConfig = {
    networkId, indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
    provingServerUrl: new URL(cfg.proofServer), relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  const wallet = await WalletFacade.init({
    configuration: walletConfig as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}
function signTransactionIntents(tx: any, signFn: (p: Uint8Array) => any, marker: 'proof' | 'pre-proof') {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const seg of tx.intents.keys()) {
    const intent = tx.intents.get(seg); if (!intent) continue;
    const cloned = ledger.Intent.deserialize('signature', marker, 'pre-binding', intent.serialize());
    const sig = signFn(cloned.signatureData(seg));
    if (cloned.fallibleUnshieldedOffer) cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(cloned.fallibleUnshieldedOffer.inputs.map((_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? sig));
    if (cloned.guaranteedUnshieldedOffer) cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(cloned.guaranteedUnshieldedOffer.inputs.map((_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? sig));
    tx.intents.set(seg, cloned);
  }
}
const dustOf = (s: any): bigint => { try { return s.dust.balance(new Date()) as bigint; } catch { return 0n; } };
async function waitForSync(wallet: any) {
  console.log('[sync] full sync...');
  const nt = ledger.unshieldedToken().raw;
  const sub = wallet.state().pipe(Rx.throttleTime(10_000)).subscribe((s: any) => console.log(`  [${hhmmss()}] synced=${s.isSynced} NIGHT:${s.unshielded?.balances?.[nt] ?? 0n}`));
  const st = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
  sub.unsubscribe(); console.log('[sync] fully synced.'); return st;
}
async function ensureDust(ctx: any) {
  const s0: any = await Rx.firstValueFrom(ctx.wallet.state());
  const un = (s0.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (un.length > 0) {
    const vk = ctx.unshieldedKeystore.getPublicKey();
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(un, vk, (p: Uint8Array) => ctx.unshieldedKeystore.signData(p));
    await ctx.wallet.submitTransaction(await ctx.wallet.finalizeRecipe(recipe));
    console.log('[dust] NIGHT registered');
  }
  await new Promise<void>((res) => {
    let prev = -1n, stable = 0; const start = Date.now();
    const sub = ctx.wallet.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const b = dustOf(s); console.log(`  [dust ${hhmmss()}] ${b}`);
      if (prev > 0n && b > 0n && (b - prev) * 200n < prev) stable++; else stable = 0; prev = b;
      if ((b > 0n && stable >= 2) || Date.now() - start >= 8 * 60_000) { sub.unsubscribe(); res(); }
    });
  });
  console.log('[dust] ready');
}
function makeWalletProvider(ctx: any, state: any) {
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(tx, { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey }, { ttl: ttl ?? new Date(Date.now() + 1800000) });
      const signFn = (p: Uint8Array) => ctx.unshieldedKeystore.signData(p);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx),
  };
}
// (B) the real value transfer — documented working path, gated by the verdict above.
async function transferNight(ctx: any, receiverAddress: any, amount: bigint) {
  const recipe = await ctx.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: ledger.unshieldedToken().raw, receiverAddress, amount }] }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await ctx.wallet.signRecipe(recipe, (p: Uint8Array) => ctx.unshieldedKeystore.signData(p));
  const tx = await ctx.wallet.finalizeRecipe(signed);
  return ctx.wallet.submitTransaction(tx);
}

async function main() {
  setNetworkId('preview');
  const seed = process.env.MIDNIGHT_SEED; if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const ctx = await createWallet(seed);
  const acc = String(ctx.unshieldedKeystore.getBech32Address());
  console.log('wallet:', acc);
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log('tNIGHT:', state.unshielded?.balances?.[nt] ?? 0n);
  await ensureDust(ctx);

  const wp = makeWalletProvider(ctx, state);
  const zkPath = buildPath('ComplianceEscrow');
  const compiled = CompiledContract.make('ComplianceEscrow', (ComplianceEscrow as any).Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath));
  const providers = {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: 'ComplianceEscrow-state', privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD ?? 'dpo2u-local-dev-private-state-pw-2026', accountId: acc }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider(zkPath), proofProvider: httpClientProofProvider(cfg.proofServer, new NodeZkConfigProvider(zkPath)), walletProvider: wp, midnightProvider: wp,
  };
  console.log('[join] ComplianceEscrow V1', ESCROW_V1.slice(0, 16), '…');
  const esc: any = await (findDeployedContract as any)(providers as any, { contractAddress: ESCROW_V1, compiledContract: compiled, privateStateId: 'ComplianceEscrowPrivateState', initialPrivateState: {} });

  const id = b32('esc-b-' + new Date().toISOString().replace(/[:.TZ-]/g, '').slice(0, 14));
  const TRANSFER = 1_000_000n; // 1e6 atomic NIGHT — the real value released to the beneficiary

  console.log('\n[1/3 createEscrow] record escrow on-chain (the gate)...');
  const c1 = await esc.callTx.createEscrow(id, b32('acme-corp'), b32('auditor-dao'), 100n, b32('lgpd_compliance_v1'));
  console.log('  ✓ tx', c1?.public?.txId, '(block', c1?.public?.blockHeight, ')');

  console.log('\n[2/3 attestAndRelease] ZK score 85>=70 → status RELEASED on-chain...');
  const c2 = await esc.callTx.attestAndRelease(id, sha32('ev||' + acc), 70n, sha32('ctx||' + Date.now()), 85n);
  console.log('  ✓ tx', c2?.public?.txId, '(block', c2?.public?.blockHeight, ') — verdict gate passed');

  console.log('\n[3/3 transferNight] verdict passed → moving', TRANSFER, 'real NIGHT to beneficiary...');
  const txId = await transferNight(ctx, ctx.unshieldedKeystore.getBech32Address(), TRANSFER);
  console.log('  ✓ transfer tx', txId, '— REAL NIGHT moved on-chain');

  fs.writeFileSync(path.resolve(__dirname, '..', 'escrow-b-result.json'), JSON.stringify({
    network: getNetworkId(), escrowContract: ESCROW_V1, escrowId: Buffer.from(id).toString('hex'),
    createTx: c1?.public?.txId, releaseTx: c2?.public?.txId, transferTx: String(txId), transferAmount: TRANSFER.toString(), at: new Date().toISOString(),
  }, null, 2));
  console.log('\n✅ (B) ROUND-TRIP OK — escrow RELEASED on-chain AND real NIGHT transferred. Saved escrow-b-result.json');
  try { await (ctx.wallet as any).close?.(); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error('\n(B) demo failed:', e?.stack ?? e); process.exit(1); });
