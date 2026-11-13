/**
 * DPO2U Paymaster — non-custodial DUST-as-a-Service relay/delegation module (ledger v9).
 *
 * DUST is non-transferable by protocol, so it cannot be sold. A NIGHT holder can instead
 * REDIRECT the DUST their NIGHT generates to the controller's dust address while KEEPING
 * custody of the NIGHT, and the controller spends that DUST on fees for attestations it
 * sponsors. What is sold is sponsored capacity, not DUST.
 *
 * Runs on preview | preprod | mainnet through scripts/lib/midnight-v9.ts (MIDNIGHT_NETWORK,
 * same mainnet guard as every v9 script). Contracts come from deployment-<network>-v9.json and
 * must be owner-gated (accessControl owner-v1); the controller signs as owner.
 *
 * Accounts: account 0 is MIDNIGHT_SEED itself; account N > 0 uses
 * sha256("dpo2u/paymaster/account/" + N || seed). These addresses differ from the old v8 HD
 * accounts, so fund the holder again (print it with `controller-dust --account 1`).
 *
 * CLIs:
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts controller-dust --account 0
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts delegate --holder-account 1 --controller-dust <mn_dust_...>
 *   MIDNIGHT_SEED=<hex> tsx scripts/dust-relay.ts deregister --holder-account 1
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ledger from '@midnight-ntwrk/ledger-v9';
import { MidnightBech32m, DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

import { networkConfig, openWallet, makeProviders, masterSeedHex, dustBalance, V10_CONTRACTS, CODE_VERSION, type NetCfg, type V9Wallet } from './lib/midnight-v9.js';
import { ownerWitnesses } from './owner.js';

// @ts-expect-error WS polyfill required for wallet sync in Node
globalThis.WebSocket = WebSocket;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hhmmss = () => new Date().toISOString().slice(11, 19);
export type WalletCtx = V9Wallet;

/** Opaque, deterministic Bytes<32> id from any address string (privacy-preserving). */
export function idFromString(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s).digest());
}

/** Seed for a paymaster account: 0 = MIDNIGHT_SEED, N > 0 = domain-separated hash of it. */
export function accountSeedHex(account: number, seedHex: string = masterSeedHex()): string {
  if (!Number.isInteger(account) || account < 0) throw new Error(`Invalid account ${account}`);
  if (account === 0) return seedHex;
  return createHash('sha256').update(`dpo2u/paymaster/account/${account}`).update(Buffer.from(seedHex, 'hex')).digest('hex');
}

export async function openAccount(net: NetCfg, account: number, label = `account ${account}`): Promise<WalletCtx> {
  return openWallet(net, { seedHex: accountSeedHex(account), label });
}

export const dustOf = dustBalance;
export const nightOf = (s: any): bigint => BigInt(s.unshielded?.balances?.[ledger.unshieldedToken().raw] ?? 0n);
export const currentState = (ctx: WalletCtx): Promise<any> => Rx.firstValueFrom(ctx.facade.state());

// ── dust address (the receiver a holder delegates to) ──
export async function dustAddressString(ctx: WalletCtx): Promise<string> {
  const st: any = await currentState(ctx);
  const raw = st.dust?.address ?? (await (ctx.facade as any).dust?.getAddress?.());
  if (!raw) throw new Error('Could not read the dust address from the wallet state');
  return MidnightBech32m.encode(ctx.net.networkId as any, raw as any).toString();
}
export function parseDustAddress(bech32: string, net: NetCfg): DustAddress {
  // decode() checks the network prefix, so a preview address is refused on mainnet.
  return MidnightBech32m.parse(bech32).decode(DustAddress as any, net.networkId as any) as DustAddress;
}

const sign = (ctx: WalletCtx) => (d: Uint8Array) => ctx.keystore.signDataAsync(d);
async function submit(ctx: WalletCtx, recipe: any): Promise<string> {
  return String(await (ctx.facade as any).submissionService.submitTransaction(await ctx.facade.finalizeRecipe(recipe), 'InBlock'));
}

// ── LEG 1 — non-custodial delegation: holder redirects DUST generation to the controller ──
// The holder signs (it owns the NIGHT); the 4th argument redirects generated DUST to the
// controller. The NIGHT never leaves the holder's wallet and the delegation is revocable.
export async function delegateDustGeneration(holder: WalletCtx, controllerDustAddress: DustAddress): Promise<string | null> {
  const st: any = await currentState(holder);
  const utxos = (st.unshielded.availableCoins ?? []).filter((u: any) => !u.meta?.registeredForDustGeneration);
  if (utxos.length === 0) { console.log('[delegate] no unregistered NIGHT UTxOs (already delegated or zero balance).'); return null; }
  console.log(`[delegate] redirecting DUST from ${utxos.length} NIGHT UTxO(s) to the controller (holder keeps NIGHT)...`);
  const recipe = await (holder.facade as any).registerNightUtxosForDustGeneration(
    utxos, holder.keystore.getPublicKey(), sign(holder), controllerDustAddress);
  const txId = await submit(holder, recipe);
  console.log(`[delegate] delegation tx ${txId}`);
  return txId;
}

/** Revocation: DUST generation returns to the holder's own dust address. */
export async function deregisterDelegation(holder: WalletCtx): Promise<string | null> {
  const st: any = await currentState(holder);
  const registered = (st.unshielded.availableCoins ?? []).filter((u: any) => u.meta?.registeredForDustGeneration);
  if (registered.length === 0) { console.log('[deregister] nothing registered.'); return null; }
  const recipe = await (holder.facade as any).deregisterFromDustGeneration(registered, holder.keystore.getPublicKey(), sign(holder));
  const txId = await submit(holder, recipe);
  console.log(`[deregister] delegation revoked: ${txId}`);
  return txId;
}

/** Waits until the controller's DUST stops growing (a usable floor arrives in minutes). */
export async function waitForDustPlateau(ctx: WalletCtx, maxWaitMs = 8 * 60_000): Promise<bigint> {
  console.log('[dust] waiting for DUST to build (plateau)...');
  const start = Date.now();
  let prev = -1n, stable = 0;
  await new Promise<void>((resolve) => {
    const sub = ctx.facade.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const bal = dustOf(s);
      console.log(`  [dust ${hhmmss()}] ${bal} (${Math.round((Date.now() - start) / 1000)}s)`);
      if (prev > 0n && bal > 0n && (bal - prev) * 200n < prev) stable++; else stable = 0;
      prev = bal;
      if ((bal > 0n && stable >= 2) || Date.now() - start >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  const bal = dustOf(await currentState(ctx));
  console.log(`[dust] settled at ${bal}.`);
  return bal;
}

// ── contract wiring: controller joins owner-gated contracts from deployment-<net>-v9.json ──
export function deploymentAddress(network: string, name: string): string {
  const file = path.join(ROOT, `deployment-${network}-v9.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} missing: deploy with scripts/deploy-v9.ts first`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8')).contracts?.[name];
  if (!c?.contractAddress) throw new Error(`${name} not in ${file}`);
  if (c.accessControl !== 'owner-v1') throw new Error(`${name} in ${file} was deployed without access control; redeploy`);
  if (V10_CONTRACTS.has(name) && c.codeVersion !== CODE_VERSION) throw new Error(`${name} in ${file} is the pre-${CODE_VERSION} layout; redeploy with scripts/deploy-v9.ts`);
  return c.contractAddress;
}

export async function joinContract(ctx: WalletCtx, secret: Uint8Array, name: string, mod: any) {
  const zkPath = path.join(ROOT, 'build', name);
  const compiled = (CompiledContract.make(name, mod.Contract) as any).pipe(
    (CompiledContract as any).withWitnesses(ownerWitnesses(secret)),
    (CompiledContract as any).withCompiledFileAssets(zkPath),
  );
  const addr = deploymentAddress(ctx.net.name, name);
  console.log(`[join] ${name} ${addr.slice(0, 16)}…`);
  return (findDeployedContract as any)(makeProviders(ctx, zkPath, `${name}-paymaster`), {
    contractAddress: addr, compiledContract: compiled,
    privateStateId: `${name}PrivateState`, initialPrivateState: {},
  });
}

// ── CLI ──
async function cli() {
  const { values, positionals } = parseArgs({
    options: {
      account: { type: 'string', default: '0' },
      'holder-account': { type: 'string', default: '1' },
      'controller-dust': { type: 'string' },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  const net = networkConfig();

  if (cmd === 'controller-dust') {
    const ctrl = await openAccount(net, Number(values.account), 'controller');
    console.log(`\nController dust address (delegate to this):\n  ${await dustAddressString(ctrl)}\n  unshielded: ${ctrl.address}`);
    return;
  }
  if (cmd === 'delegate') {
    if (!values['controller-dust']) throw new Error('--controller-dust <mn_dust_...> required');
    const target = parseDustAddress(String(values['controller-dust']), net);
    const holder = await openAccount(net, Number(values['holder-account']), 'holder');
    const before = nightOf(await currentState(holder));
    await delegateDustGeneration(holder, target);
    const after = nightOf(await currentState(holder));
    console.log(`\nDelegated. Holder NIGHT before=${before} after=${after} (custody retained).`);
    return;
  }
  if (cmd === 'deregister') {
    await deregisterDelegation(await openAccount(net, Number(values['holder-account']), 'holder'));
    return;
  }
  console.error('Usage: dust-relay.ts <controller-dust|delegate|deregister> [flags]');
  process.exitCode = 1;
}

// Run as CLI only when invoked directly (not when imported by paymaster-demo.ts).
if (process.argv[1] && process.argv[1].endsWith('dust-relay.ts')) {
  cli().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('\ndust-relay failed:', e?.stack ?? e); process.exit(1); });
}
