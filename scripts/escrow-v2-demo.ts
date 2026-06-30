/**
 * C2 experiment — REAL native-token (NIGHT) escrow round-trip on preview.
 * Deploys ComplianceEscrowV2, then: createEscrow (funds the contract with real NIGHT via
 * receiveUnshielded) → attestAndRelease (ZK score>=threshold → sendUnshielded to beneficiary).
 * Self-escrow: payer = beneficiary = the agent's own unshielded address (getAddress()).
 * The open question this tests: does balanceUnboundTransaction auto-attach the NIGHT for receiveUnshielded?
 *
 *   MIDNIGHT_SEED=<hex> NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/escrow-v2-demo.ts
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
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ComplianceEscrowV2 from '../build/ComplianceEscrowV2/contract/index.js';

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

function deriveKeys(seed: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return r.keys;
}
async function createWallet(seed: string) {
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
    console.log('[dust] NIGHT registered for dust gen');
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
function makeProviders(wp: any, zkPath: string, store: string, acc: string) {
  const zk = new NodeZkConfigProvider(zkPath);
  return {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: store, privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD ?? 'dpo2u-local-dev-private-state-pw-2026', accountId: acc }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider: zk, proofProvider: httpClientProofProvider(cfg.proofServer, zk), walletProvider: wp, midnightProvider: wp,
  };
}

async function main() {
  setNetworkId('preview');
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const ctx = await createWallet(seed);
  const acc = String(ctx.unshieldedKeystore.getBech32Address());
  console.log('wallet:', acc);
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  console.log('tNIGHT:', state.unshielded?.balances?.[nt] ?? 0n);
  await ensureDust(ctx);

  const wp = makeWalletProvider(ctx, state);
  const zkPath = buildPath('ComplianceEscrowV2');
  const compiled = CompiledContract.make('ComplianceEscrowV2', (ComplianceEscrowV2 as any).Contract).pipe(
    CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(zkPath));
  const providers = makeProviders(wp, zkPath, 'ComplianceEscrowV2-state', acc);

  console.log('\n[deploy] ComplianceEscrowV2...');
  const deployed: any = await (deployContract as any)(providers as any, { compiledContract: compiled, privateStateId: 'ComplianceEscrowV2PrivateState', initialPrivateState: {} });
  const addr = deployed.deployTxData.public.contractAddress;
  console.log('[deploy] V2 at', addr, '(block', deployed.deployTxData.public.blockHeight, ')');

  // self-escrow: payer = beneficiary = our own unshielded address.
  // getAddress() returns the address as a 64-hex string; the contract wants struct
  // UserAddress { bytes: Bytes<32> } => TS { bytes: Uint8Array }. Wrap it.
  const rawAddr: any = ctx.unshieldedKeystore.getAddress();
  const addrHex = (typeof rawAddr === 'string' ? rawAddr : (rawAddr?.bytes ? Buffer.from(rawAddr.bytes).toString('hex') : String(rawAddr))).replace(/^0x/, '');
  const myAddr = { bytes: new Uint8Array(Buffer.from(addrHex, 'hex')) };
  console.log('UserAddress bytes:', addrHex, '(len', myAddr.bytes.length, ')');
  const escrowId = b32('esc-v2-' + new Date().toISOString().replace(/[:.TZ-]/g, '').slice(0, 14));
  const AMOUNT = 1000000n; // 1e6 atomic NIGHT (we hold 2e9)

  console.log('\n[createEscrow] funding contract with', AMOUNT, 'NIGHT via receiveUnshielded...');
  const cr1 = await deployed.callTx.createEscrow(escrowId, myAddr, myAddr, AMOUNT, b32('lgpd_compliance_v1'));
  console.log('  ✓ createEscrow tx', cr1?.public?.txId, '(block', cr1?.public?.blockHeight, ')');

  console.log('\n[attestAndRelease] ZK score 85>=70 → sendUnshielded to beneficiary...');
  const cr2 = await deployed.callTx.attestAndRelease(escrowId, sha32('ev||' + acc), 70n, sha32('ctx||' + Date.now()), 85n);
  console.log('  ✓ attestAndRelease tx', cr2?.public?.txId, '(block', cr2?.public?.blockHeight, ')');

  fs.writeFileSync(path.resolve(__dirname, '..', 'escrow-v2-result.json'), JSON.stringify({
    network: getNetworkId(), contractAddress: addr, escrowId: Buffer.from(escrowId).toString('hex'),
    amount: AMOUNT.toString(), createTx: cr1?.public?.txId, releaseTx: cr2?.public?.txId, at: new Date().toISOString(),
  }, null, 2));
  console.log('\n✅ ROUND-TRIP OK — real NIGHT custody + conditional release worked. Saved escrow-v2-result.json');
  try { await (ctx.wallet as any).close?.(); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error('\nC2 demo failed:', e?.stack ?? e); process.exit(1); });
