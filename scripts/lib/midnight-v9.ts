/**
 * Shared ledger-v9 plumbing (midnight-js 5 / wallet-sdk 2): network config, wallet, DUST, providers.
 * Extracted from scripts/registry-v9.ts so every v9 script (deploy, LGPD executor, agent) uses one
 * network table and one mainnet guard.
 *
 * Networks: preview | preprod | mainnet (MIDNIGHT_NETWORK, default preview).
 * Mainnet is refused unless ALL of these hold:
 *   - CONFIRM_MAINNET=yes
 *   - BLOCKFROST_PROJECT_ID is set (Midnight-hosted mainnet endpoints were retired on 2026-10-09)
 *   - DPO2U_OWNER_SECRET is set explicitly (no owner secret derived from the wallet seed)
 *   - PRIVATE_STATE_PASSWORD is set (no default password)
 * Mainnet has no faucet: ensureDust only registers NIGHT the wallet already holds.
 */
import * as Rx from 'rxjs';
import { Either } from 'effect';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createLedger9WalletProvider, createLedger9MidnightProvider } from '@midnight-ntwrk/midnight-js-types';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletSeeds } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { WalletTransaction, ProtocolVersion, InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';

export type NetworkName = 'preview' | 'preprod' | 'mainnet';
export type NetCfg = { name: NetworkName; networkId: string; indexer: string; indexerWS: string; node: string; proofServer: string };

const PROOF_SERVER = () => process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';

export function networkConfig(name: string = process.env.MIDNIGHT_NETWORK ?? 'preview'): NetCfg {
  switch (name) {
    case 'preview':
      return { name, networkId: 'preview', proofServer: PROOF_SERVER(),
        indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
        indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
        node: 'https://rpc.preview.midnight.network' };
    case 'preprod':
      return { name, networkId: 'preprod', proofServer: PROOF_SERVER(),
        indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
        indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
        node: 'https://rpc.preprod.midnight.network' };
    case 'mainnet': {
      assertMainnetAllowed();
      const q = `?project_id=${encodeURIComponent(process.env.BLOCKFROST_PROJECT_ID!)}`;
      // https://docs.midnight.network/guides/networks-and-environments (Blockfrost is the mainnet provider)
      return { name, networkId: 'mainnet', proofServer: PROOF_SERVER(),
        indexer: `https://midnight-mainnet.blockfrost.io/api/v0${q}`,
        indexerWS: `wss://midnight-mainnet.blockfrost.io/api/v0/ws${q}`,
        node: `https://rpc.midnight-mainnet.blockfrost.io${q}` };
    }
    default:
      throw new Error(`Unknown MIDNIGHT_NETWORK "${name}" (preview | preprod | mainnet)`);
  }
}

export function assertMainnetAllowed(): void {
  const missing: string[] = [];
  if (process.env.CONFIRM_MAINNET !== 'yes') missing.push('CONFIRM_MAINNET=yes');
  if (!process.env.BLOCKFROST_PROJECT_ID) missing.push('BLOCKFROST_PROJECT_ID');
  if (!process.env.DPO2U_OWNER_SECRET) missing.push('DPO2U_OWNER_SECRET (explicit, not derived from the seed)');
  if (!process.env.PRIVATE_STATE_PASSWORD) missing.push('PRIVATE_STATE_PASSWORD');
  if (missing.length) throw new Error(`Mainnet refused. Missing: ${missing.join(', ')}`);
}

export function masterSeedHex(): string {
  const s = (process.env.MIDNIGHT_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error('MIDNIGHT_SEED missing or not hex');
  return s;
}

export type V9Wallet = { facade: any; keystore: any; state: any; net: NetCfg; address: string };

export async function openWallet(net: NetCfg, opts: { syncTimeoutMs?: number } = {}): Promise<V9Wallet> {
  setNetworkId(net.networkId as any);
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(masterSeedHex(), 'hex'));
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded } as any, getNetworkId() as any);
  const address = String((keystore as any).getBech32Address?.() ?? (keystore as any).getAddress?.() ?? '');
  const configuration = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: net.indexer, indexerWsUrl: net.indexerWS },
    provingServerUrl: new URL(net.proofServer),
    relayURL: new URL(net.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    // Without a history store the facade's submit path crashes and hides the real outcome.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema as any, mergeWalletEntries as any),
  };
  const facade = await WalletFacade.init({
    configuration: configuration as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSeed(seeds.shielded),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (c: any) => DustWallet(c).startWithSeed(seeds.dust),
  } as any);
  await facade.start(seeds);
  console.log(`[wallet] ${net.name}: ${address} — syncing...`);
  const state: any = await Rx.firstValueFrom(
    facade.state().pipe(Rx.filter((s: any) => s.isSynced === true), Rx.timeout({ first: opts.syncTimeoutMs ?? 30 * 60_000 })),
  );
  console.log('[wallet] synced');
  return { facade, keystore, state, net, address };
}

export const dustBalance = (st: any): bigint => { try { return BigInt(st.dust.balance(new Date())); } catch { return 0n; } };

/** Registers unregistered NIGHT UTxOs for DUST generation (once), then waits until DUST plateaus. */
export async function ensureDust(w: V9Wallet, opts: { maxWaitMs?: number } = {}): Promise<bigint> {
  const { facade, keystore } = w;
  const st: any = await Rx.firstValueFrom(facade.state());
  const night = (st.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (night.length > 0) {
    console.log(`[dust] registering ${night.length} NIGHT UTxO(s) for DUST generation...`);
    const vk = keystore.getPublicKey();
    const sign = (d: Uint8Array) => keystore.signDataAsync(d);
    const register = () => facade.registerNightUtxosForDustGeneration(night, vk, sign);
    const recipe = await register().catch(async (e: any) => {
      if (e?._tag !== 'Wallet.InsufficientDustForFee' || e?.estimate?._tag !== 'Reachable') throw e;
      const timeoutMs = Number(e.estimate.seconds) * 1000 + 60_000;
      console.log(`[dust] registration fee not covered yet; waiting up to ${Math.round(timeoutMs / 1000)}s`);
      await facade.waitForGeneratedDust(night, e.fee, { timeoutMs });
      return register();
    });
    await facade.submissionService.submitTransaction(await facade.finalizeRecipe(recipe), 'InBlock');
  }
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000, t0 = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = facade.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustBalance(s), el = Date.now() - t0;
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || el >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  const bal = dustBalance(await Rx.firstValueFrom(facade.state()));
  console.log(`[dust] balance ${bal}`);
  return bal;
}

async function handleBytes(facade: any, handle: any): Promise<Uint8Array> {
  const v = (await Rx.firstValueFrom(facade.state()) as any).activeProtocolVersion;
  const range = (ProtocolVersion as any).makeRange(v, typeof v === 'bigint' ? v + 1n : v + 1);
  const tx = Either.getOrThrow((WalletTransaction as any).unwrapWithin(handle, range)) as { serialize(): Uint8Array };
  return tx.serialize();
}

export function makeProviders(w: V9Wallet, zkDir: string, storeName: string): any {
  const { facade, keystore, state, net } = w;
  const password = process.env.PRIVATE_STATE_PASSWORD
    ?? (net.name === 'mainnet' ? (() => { throw new Error('PRIVATE_STATE_PASSWORD required on mainnet'); })() : 'dpo2u-local-dev-private-state-pw-2026');
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
  const zkConfigProvider = new NodeZkConfigProvider(zkDir);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${storeName}-${net.name}`,
      privateStoragePasswordProvider: () => password,
      accountId: state.shielded.coinPublicKey.toHexString(),
    } as any),
    publicDataProvider: indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS } as any),
    zkConfigProvider,
    proofProvider: httpClientProofProvider({ url: net.proofServer, zkConfigProvider } as any),
    walletProvider,
    midnightProvider,
    config: { networkId: net.networkId, ttlSeconds: 1800 },
  };
}
