/**
 * ComplianceRegistry on the ledger-v9 Midnight (preview after the Nov/2026 reset).
 *
 *   npx tsx scripts/registry-v9.ts deploy                      # deploy, write deployment-preview-v9.json
 *   npx tsx scripts/registry-v9.ts attest <useCase> <verdict> <evidenceHex> <metadataHex>
 *
 * Env: MIDNIGHT_SEED (hex master seed, never printed), PROOF_SERVER_URL (default :6311, proof-server 9.0.1).
 * Written against midnight-js 5 / wallet-sdk 2 / ledger-v9: the wallet starts from seeds
 * (WalletSeeds.fromMasterSeed), balancing takes no keys and unshielded intents are signed with
 * signRecipe. The old v8 deploy scripts live in scripts/legacy-v8/ (reference only).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Rx from 'rxjs';
import { Either } from 'effect';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { createLedger9WalletProvider, createLedger9MidnightProvider } from '@midnight-ntwrk/midnight-js-types';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ownerSecret, ownerWitnesses, ownerCommit } from './owner.js';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, WalletSeeds } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { WalletTransaction, ProtocolVersion, InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NET = {
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6311',
};
const OUT = path.join(ROOT, 'deployment-preview-v9.json');
const ZK = path.join(ROOT, 'build', 'ComplianceRegistry');

const b32 = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(s.length, 32)); return new Uint8Array(b); };
const hex32 = (h: string) => { const c = h.replace(/^0x/, ''); if (!/^[0-9a-fA-F]{64}$/.test(c)) throw new Error('expected 32-byte hex'); return new Uint8Array(Buffer.from(c, 'hex')); };

function masterSeed(): Uint8Array {
  const s = (process.env.MIDNIGHT_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error('MIDNIGHT_SEED missing or not hex');
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function unshieldedSecret(seed: Uint8Array): Uint8Array {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new Error('invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.NightExternal]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('key derivation failed');
  hd.hdWallet.clear();
  return r.keys[Roles.NightExternal];
}

async function openWallet() {
  setNetworkId('preview');
  const seed = masterSeed();
  const configuration = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: NET.indexer, indexerWsUrl: NET.indexerWS },
    provingServerUrl: new URL(NET.proofServer),
    relayURL: new URL(NET.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    // The facade records submissions and their outcome here; without it the submit path crashes
    // ("gotRejected"/"gotFinalized" of undefined) and masks the real result.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema as any, mergeWalletEntries as any),
  };
  const seeds = WalletSeeds.fromMasterSeed(seed);
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded } as any, getNetworkId() as any);
  const legacy = createKeystore({ kind: 'schnorr', secret: unshieldedSecret(seed) } as any, getNetworkId() as any);
  const addr = String((keystore as any).getBech32Address?.() ?? (keystore as any).getAddress?.() ?? '');
  const legacyAddr = String((legacy as any).getBech32Address?.() ?? (legacy as any).getAddress?.() ?? '');
  console.log(`[wallet] unshielded address (v9 seeds): ${addr}`);
  console.log(`[wallet] unshielded address (v8 derivation): ${legacyAddr}`);
  if (process.env.ADDRESS_ONLY) process.exit(0);
  const facade = await WalletFacade.init({
    configuration: configuration as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSeed(seeds.shielded),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (c: any) => DustWallet(c).startWithSeed(seeds.dust),
  } as any);
  await facade.start(seeds);
  console.log('[wallet] syncing...');
  const state: any = await Rx.firstValueFrom(
    facade.state().pipe(Rx.filter((s: any) => s.isSynced === true), Rx.timeout({ first: 30 * 60_000 })),
  );
  console.log('[wallet] synced');
  return { facade, keystore, state };
}


/** DUST: the faucet gives NIGHT only. Register NIGHT UTxOs for dust generation (the SDK's documented
 *  retry when the registration fee is "Reachable"), then wait until the dust balance plateaus. */
async function ensureDust(w: { facade: any; keystore: any }) {
  const { facade, keystore } = w;
  const dustOf = (st: any) => { try { return BigInt(st.dust.balance(new Date())); } catch { return 0n; } };
  const st: any = await Rx.firstValueFrom(facade.state());
  const night = (st.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (night.length > 0) {
    console.log(`[dust] registering ${night.length} NIGHT UTxO(s) for dust generation...`);
    const vk = keystore.getPublicKey();
    const sign = (d: Uint8Array) => keystore.signDataAsync(d);
    const register = () => facade.registerNightUtxosForDustGeneration(night, vk, sign);
    const recipe = await register().catch(async (e: any) => {
      if (e?._tag !== 'Wallet.InsufficientDustForFee' || e?.estimate?._tag !== 'Reachable') throw e;
      const timeoutMs = Number(e.estimate.seconds) * 1000 + 60_000;
      console.log(`[dust] registration fee not covered yet; waiting up to ${Math.round(timeoutMs / 1000)}s for generated dust`);
      await facade.waitForGeneratedDust(night, e.fee, { timeoutMs });
      return register();
    });
    const finalized = await facade.finalizeRecipe(recipe);
    try {
      const ev: any = await facade.submissionService.submitTransaction(finalized, 'InBlock');
      console.log(`[dust] registration in block: ${JSON.stringify(ev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300)}`);
    } catch (e: any) {
      const chain: string[] = [];
      for (let c: any = e, i = 0; c && i < 6; c = c.cause, i++) chain.push(`${c?._tag ?? c?.name ?? typeof c}: ${String(c?.message ?? c).slice(0, 400)}`);
      console.error('[dust] registration submit failed:\n  ' + chain.join('\n  '));
      throw e;
    }
  } else {
    console.log(`[dust] NIGHT already registered (balance ${dustOf(st)})`);
  }
  const maxWaitMs = 15 * 60_000, t0 = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = facade.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustOf(s), el = Date.now() - t0;
      console.log(`  [dust] balance ${bal} (${Math.round(el / 1000)}s)`);
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || el >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  console.log(`[dust] settled at ${dustOf(await Rx.firstValueFrom(facade.state()))}`);
}

/** Bytes of a facade handle, read at the facade's own protocol version. */
async function handleBytes(facade: any, handle: any): Promise<Uint8Array> {
  const v = (await Rx.firstValueFrom(facade.state()) as any).activeProtocolVersion;
  const range = (ProtocolVersion as any).makeRange(v, typeof v === 'bigint' ? v + 1n : v + 1); // half-open [v, v+1)
  const tx = Either.getOrThrow((WalletTransaction as any).unwrapWithin(handle, range)) as { serialize(): Uint8Array };
  return tx.serialize();
}

function providers(w: Awaited<ReturnType<typeof openWallet>>) {
  const { facade, keystore, state } = w;
  const walletProvider = createLedger9WalletProvider({
    balanceTx: async (tx, ttl) => {
      const handle = facade.adoptTransaction(tx.serialize(), 'Unbound');
      const recipe = await facade.balanceUnboundTransaction(handle as any, { ttl: ttl ?? new Date(Date.now() + 30 * 60_000) });
      const signed = await facade.signRecipe(recipe, (data: Uint8Array) => keystore.signDataAsync(data));
      return await handleBytes(facade, await facade.finalizeRecipe(signed));
    },
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
  });
  const midnightProvider = createLedger9MidnightProvider(async (tx) =>
    (await facade.submitTransaction(facade.adoptTransaction(tx.serialize(), 'Finalized') as any)) as any);
  const zkConfigProvider = new NodeZkConfigProvider(ZK);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'ComplianceRegistry-v9-state',
      privateStoragePasswordProvider: () => process.env.PRIVATE_STATE_PASSWORD ?? 'dpo2u-local-dev-private-state-pw-2026',
      accountId: state.shielded.coinPublicKey.toHexString(),
    } as any),
    publicDataProvider: indexerPublicDataProvider({ queryURL: NET.indexer, subscriptionURL: NET.indexerWS } as any),
    zkConfigProvider,
    proofProvider: httpClientProofProvider({ url: NET.proofServer, zkConfigProvider } as any),
    walletProvider,
    midnightProvider,
    config: { networkId: getNetworkId(), ttlSeconds: 1800 },
  } as any;
}

async function contractModule() {
  return import(path.join(ZK, 'contract', 'index.js'));
}

async function compiled() {
  const mod = await contractModule();
  return (CompiledContract.make('ComplianceRegistry', mod.Contract as any) as any).pipe(
    (CompiledContract as any).withWitnesses(ownerWitnesses(ownerSecret(Buffer.from(masterSeed()).toString('hex')))),
    (CompiledContract as any).withCompiledFileAssets(ZK),
  );
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const w = await openWallet();
  await ensureDust(w);
  const p = providers(w);
  if (cmd === 'deploy') {
    const commit = ownerCommit(await contractModule(), ownerSecret(Buffer.from(masterSeed()).toString('hex')));
    const c: any = await (deployContract as any)(p, { compiledContract: await compiled(), privateStateId: 'ComplianceRegistryPrivateState', initialPrivateState: {}, args: [commit] });
    const d = c.deployTxData.public;
    const out = { network: 'preview', ledger: 'v9', deployedAt: new Date().toISOString(),
      contracts: [{ name: 'ComplianceRegistry', contractAddress: d.contractAddress, blockHeight: d.blockHeight, txId: d.txId, accessControl: 'owner-v1' }] };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log('DEPLOY_RESULT ' + JSON.stringify(out.contracts[0]));
  } else if (cmd === 'attest') {
    const [useCase, verdict, ev, md] = args;
    const dep = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const addr = dep.contracts.find((x: any) => x.name === 'ComplianceRegistry').contractAddress;
    const cr: any = await (findDeployedContract as any)(p, { contractAddress: addr, compiledContract: await compiled(), privateStateId: 'ComplianceRegistryPrivateState', initialPrivateState: {} });
    const r = await cr.callTx.attestUseCase(b32(useCase), BigInt(verdict), hex32(ev), hex32(md));
    console.log('ATTEST_RESULT ' + JSON.stringify({ contractAddress: addr, txId: r?.public?.txId, txHash: r?.public?.txHash, blockHeight: r?.public?.blockHeight }));
  } else {
    throw new Error('usage: deploy | attest <useCase> <verdict> <evidenceHex> <metadataHex>');
  }
  await w.facade.stop?.();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
