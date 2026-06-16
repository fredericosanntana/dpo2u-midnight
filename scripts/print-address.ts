/**
 * Derive the public funding address (Bech32 unshielded) from MIDNIGHT_SEED, for `--network`.
 * Pure key derivation — no network, no sync. Prints ONLY the public address (never the seed).
 *   npx tsx scripts/print-address.ts [--network preprod|preview|standalone]
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

const NETWORK_IDS: Record<string, string> = {
  preprod: 'preprod',
  preview: 'preview',
  standalone: 'undeployed',
};

const { values } = parseArgs({
  options: { network: { type: 'string', default: process.env.MIDNIGHT_NETWORK ?? 'preprod' } },
});
const net = String(values.network);
const networkId = NETWORK_IDS[net] ?? net;

const seed = process.env.MIDNIGHT_SEED;
if (!seed) throw new Error('MIDNIGHT_SEED not set in .env');

const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
if (hd.type !== 'seedOk') throw new Error('Bad HD seed');
const result = hd.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
  .deriveKeysAt(0);
if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
hd.hdWallet.clear();

const keystore = createKeystore(result.keys[Roles.NightExternal], networkId);
console.log(`network:  ${net} (networkId=${networkId})`);
console.log(`address:  ${keystore.getBech32Address()}`);
console.log(`faucet:   https://faucet.${net}.midnight.network/`);
