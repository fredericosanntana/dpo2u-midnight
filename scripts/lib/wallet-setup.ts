import * as fs from 'fs';
import * as path from 'path';
import * as Rx from 'rxjs';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { mnemonicToSeedSync } from '@scure/bip39';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import {
    UnshieldedWallet,
    createKeystore,
    InMemoryTransactionHistoryStorage,
    type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from './node-zk-config-provider.js';
import type { WalletProvider, MidnightProvider, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type { ContractAddress, SigningKey } from '@midnight-ntwrk/compact-runtime';

const NETWORK_ID = process.env.MIDNIGHT_NETWORK_ID || 'preprod';
const PKEY_FILE = path.join(process.cwd(), '.midnight-mnemonic');

const INDEXER_HTTP = process.env.INDEXER_HTTP_URL || 'https://indexer.preprod.midnight.network/api/v3/graphql';
const INDEXER_WS = process.env.INDEXER_WS_URL || 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws';
const PROOF_SERVER = process.env.PROOF_SERVER_URL || 'http://localhost:6300';
const NODE_URL = process.env.NODE_URL || 'wss://rpc.preprod.midnight.network';

export interface WalletContext {
    wallet: WalletFacade;
    shieldedSecretKeys: ledger.ZswapSecretKeys;
    dustSecretKey: ledger.DustSecretKey;
    unshieldedKeystore: UnshieldedKeystore;
    coinPublicKey: string; // ledger.CoinPublicKey is a string alias
    encryptionPublicKey: string; // ledger.EncPublicKey is a string alias
}

export async function setupWallet(): Promise<WalletContext> {
    let seed: Uint8Array;

    // Support raw hex seed (e.g. genesis wallet for local devnet)
    const rawSeed = process.env.MIDNIGHT_RAW_SEED;
    if (rawSeed) {
        console.log('  Using raw hex seed from MIDNIGHT_RAW_SEED env var');
        seed = Uint8Array.from(Buffer.from(rawSeed, 'hex'));
    } else {
        if (!fs.existsSync(PKEY_FILE)) {
            throw new Error('Mnemonic file not found. Run init-wallet.ts first.');
        }
        const mnemonic = fs.readFileSync(PKEY_FILE, 'utf-8').trim();
        seed = mnemonicToSeedSync(mnemonic);
    }

    const hdWallet = HDWallet.fromSeed(seed);

    const hdw = (hdWallet as any).hdWallet ?? hdWallet;
    const derivationResult = hdw
        .selectAccount(0)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
        .deriveKeysAt(0);

    // derivationResult may have .keys directly or nested under .keys after type check
    const keys = derivationResult.keys || derivationResult;

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);

    const isDevnet = NETWORK_ID === 'undeployed';
    const configuration: any = {
        networkId: NETWORK_ID,
        costParameters: {
            additionalFeeOverhead: isDevnet ? 300_000_000_000_000_000n : 300_000_000_000_000n,
            feeBlocksMargin: 5,
        },
        relayURL: new URL(NODE_URL),
        provingServerUrl: new URL(PROOF_SERVER),
        indexerClientConnection: {
            indexerHttpUrl: INDEXER_HTTP,
            indexerWsUrl: INDEXER_WS,
        },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    };

    console.log('  Starting wallet facade...');
    const shielded = ShieldedWallet(configuration as any).startWithSecretKeys(shieldedSecretKeys);
    const unshielded = UnshieldedWallet(configuration as any).startWithPublicKey(
        (await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet')).PublicKey.fromKeyStore(unshieldedKeystore),
    );
    const dust = DustWallet(configuration as any).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
    );

    const wallet = new WalletFacade(shielded, unshielded, dust);
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    console.log('  Syncing with network...');
    const syncStart = Date.now();

    // Monitor state changes in background for visibility
    const sub = wallet.state().subscribe((state: any) => {
        const elapsed = ((Date.now() - syncStart) / 1000).toFixed(0);
        console.log(`  [sync] ${elapsed}s | isSynced=${state.isSynced}`);
    });

    // Heartbeat every 15s
    const hb = setInterval(() => {
        const elapsed = ((Date.now() - syncStart) / 1000).toFixed(0);
        console.log(`  [heartbeat] ${elapsed}s — still waiting...`);
    }, 15_000);

    try {
        await wallet.waitForSyncedState();
    } finally {
        sub.unsubscribe();
        clearInterval(hb);
    }
    const syncTime = ((Date.now() - syncStart) / 1000).toFixed(1);
    console.log(`  Wallet synced in ${syncTime}s.`);

    return {
        wallet,
        shieldedSecretKeys,
        dustSecretKey,
        unshieldedKeystore,
        coinPublicKey: shieldedSecretKeys.coinPublicKey,
        encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
    };
}

// Workaround for wallet SDK bug: signRecipe uses hardcoded 'pre-proof' marker
// when cloning intents, but proven (UnboundTransaction) intents have 'proof' data.
// See: https://github.com/midnightntwrk/example-counter
function signTransactionIntents(
    tx: { intents?: Map<number, any> },
    signFn: (payload: Uint8Array) => any,
    proofMarker: 'proof' | 'pre-proof',
): void {
    if (!tx.intents || tx.intents.size === 0) return;

    for (const segment of tx.intents.keys()) {
        const intent = tx.intents.get(segment);
        if (!intent) continue;

        const cloned = ledger.Intent.deserialize(
            'signature',
            proofMarker,
            'pre-binding',
            intent.serialize(),
        );

        const sigData = cloned.signatureData(segment);
        const signature = signFn(sigData);

        if (cloned.fallibleUnshieldedOffer) {
            const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
                (_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
            );
            cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
        }

        if (cloned.guaranteedUnshieldedOffer) {
            const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
                (_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
            );
            cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
        }

        tx.intents.set(segment, cloned);
    }
}

export function buildProviders(ctx: WalletContext, buildDir?: string) {
    const zkConfigProvider = new NodeZkConfigProvider(buildDir);

    const publicDataProvider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);

    const proofProvider = httpClientProofProvider(PROOF_SERVER, zkConfigProvider);

    const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);

    const walletProvider: WalletProvider = {
        balanceTx: async (tx: any, ttl?: Date) => {
            const recipe = await ctx.wallet.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
                { ttl: ttl || new Date(Date.now() + 3600_000) },
            );
            // Manual signing: use correct proof markers instead of buggy signRecipe
            signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
            if (recipe.balancingTransaction) {
                signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
            }
            return ctx.wallet.finalizeRecipe(recipe);
        },
        getCoinPublicKey: () => ctx.coinPublicKey as any,
        getEncryptionPublicKey: () => ctx.encryptionPublicKey as any,
    };

    const midnightProvider: MidnightProvider = {
        submitTx: (tx: any) => ctx.wallet.submitTransaction(tx),
    };

    // In-memory private state provider (ComplianceRegistry has no private state)
    const privateStateStore = new Map<string, any>();
    const signingKeyStore = new Map<string, SigningKey>();
    let scopedAddress: ContractAddress | null = null;

    const privateStateProvider: PrivateStateProvider = {
        setContractAddress(address: ContractAddress) {
            scopedAddress = address;
        },
        async set(id: string, state: any) {
            privateStateStore.set(`${scopedAddress}:${id}`, state);
        },
        async get(id: string) {
            return privateStateStore.get(`${scopedAddress}:${id}`) ?? null;
        },
        async remove(id: string) {
            privateStateStore.delete(`${scopedAddress}:${id}`);
        },
        async clear() {
            privateStateStore.clear();
        },
        async setSigningKey(address: ContractAddress, signingKey: SigningKey) {
            signingKeyStore.set(String(address), signingKey);
        },
        async getSigningKey(address: ContractAddress) {
            return signingKeyStore.get(String(address)) ?? null;
        },
        async removeSigningKey(address: ContractAddress) {
            signingKeyStore.delete(String(address));
        },
        async clearSigningKeys() {
            signingKeyStore.clear();
        },
        async exportPrivateStates() {
            throw new Error('Not implemented');
        },
        async importPrivateStates() {
            throw new Error('Not implemented');
        },
    };

    return {
        privateStateProvider,
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        walletProvider,
        midnightProvider,
    };
}
