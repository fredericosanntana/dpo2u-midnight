/**
 * SOTA gap (2) — EARN: an independent CLIENT pays the agent real NIGHT for a compliance attestation.
 * Derives account index 1 (the client — a distinct on-chain address, faucet-funded), syncs, and
 * transfers NIGHT to the agent's address (account 0). The agent's balance grows = REAL revenue from
 * a distinct party. This is the inbound twin of the (B) transfer (same documented mechanism).
 *
 *   MIDNIGHT_SEED=<hex> NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/client-pays.ts
 *   flags: --to <agent bech32> (default the account-0 agent) --amount <atomic NIGHT> (default 5e6)
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';

// @ts-expect-error WS polyfill
globalThis.WebSocket = WebSocket;
const hhmmss = () => new Date().toISOString().slice(11, 19);
const cfg = {
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
};
const AGENT_ADDR = 'mn_addr_preview1jelp33c5gftpr9gl62yynuccsgny8e9cvgh89rfguct7pcmdcjzqlylk84';

function deriveKeys(seed: string, account: number) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const r = hd.hdWallet.selectAccount(account).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear(); return r.keys;
}
async function createWallet(seed: string, account: number) {
  const keys = deriveKeys(seed, account);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const wallet = await WalletFacade.init({
    configuration: { networkId, indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS }, provingServerUrl: new URL(cfg.proofServer), relayURL: new URL(cfg.node.replace(/^http/, 'ws')), costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } } as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
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

async function main() {
  const { values } = parseArgs({ options: { to: { type: 'string', default: AGENT_ADDR }, amount: { type: 'string', default: '5000000' }, account: { type: 'string', default: '1' } } });
  setNetworkId('preview');
  const seed = process.env.MIDNIGHT_SEED; if (!seed) throw new Error('MIDNIGHT_SEED not set');
  const amount = BigInt(String(values.amount));
  const to = String(values.to);

  const ctx = await createWallet(seed, Number(values.account));
  console.log('CLIENT wallet (account', values.account, '):', String(ctx.unshieldedKeystore.getBech32Address()));
  const state: any = await waitForSync(ctx.wallet);
  const nt = ledger.unshieldedToken().raw;
  const bal = state.unshielded?.balances?.[nt] ?? 0n;
  console.log('client tNIGHT:', bal);
  if (bal < amount) throw new Error(`client has ${bal} NIGHT, needs >= ${amount}. Fund the client address from the faucet first.`);
  await ensureDust(ctx);

  console.log(`\n[PAY] client → agent: ${amount} NIGHT to ${to.slice(0, 24)}…`);
  const recipe = await ctx.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: nt, receiverAddress: MidnightBech32m.parse(to) as any, amount }] }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await ctx.wallet.signRecipe(recipe, (p: Uint8Array) => ctx.unshieldedKeystore.signData(p));
  const tx = await ctx.wallet.finalizeRecipe(signed);
  const txId = String(await ctx.wallet.submitTransaction(tx));
  console.log(`  ✓ payment tx ${txId} — REAL NIGHT sent client → agent (EARN)`);

  fs.writeFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'client-payment.json'), JSON.stringify({
    network: getNetworkId(), from: String(ctx.unshieldedKeystore.getBech32Address()), to, amount: amount.toString(), txId, at: new Date().toISOString(),
  }, null, 2));
  console.log('\n✅ EARN proven — client paid the agent real NIGHT. Saved client-payment.json');
  try { await (ctx.wallet as any).close?.(); } catch {}
  process.exit(0);
}
main().catch((e) => { console.error('\nclient-pays failed:', e?.stack ?? e); process.exit(1); });
