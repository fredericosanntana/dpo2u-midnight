/**
 * DPO2U Midnight — autonomous self-funding compliance agent, ledger v9 (midnight-js 5 / wallet-sdk 2).
 *
 * WHAT: sync the wallet once, then drain a work queue of compliance attestations, sealing each on the
 * live owner-gated contracts (ComplianceRegistry, ComplianceEscrow, TrustStackRegistry, ...). The agent's
 * key is the contracts' owner: it supplies owner_secret (scripts/owner.ts) to every write.
 *
 * SELF-FUNDING WATCHDOG: before every attestation, ensure DUST is above a floor; if not, wait for it to
 * regenerate from the agent's own registered NIGHT. Every attestation's DUST cost is written to a
 * break-even ledger (agent-ledger.json). There is no faucet fallback: on mainnet the only fuel is NIGHT
 * the wallet holds, so a long DUST shortfall is reported, not papered over.
 *
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/agent.ts --once
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/agent.ts --watch --interval 120
 *   flags: --queue <path> (default agent-queue.json) --dust-floor <bigint> --fee <n>
 *   env:   MIDNIGHT_SEED, PROOF_SERVER_URL, DPO2U_OWNER_SECRET; mainnet guard in scripts/lib/midnight-v9.ts
 * Contract addresses come from deployment-<network>-v9.json (scripts/deploy-v9.ts).
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import * as ledger from '@midnight-ntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { networkConfig, openWallet, ensureDust, makeProviders, masterSeedHex, dustBalance, V10_CONTRACTS, CODE_VERSION, type V9Wallet } from './lib/midnight-v9.js';
import { ownerSecret, ownerWitnesses, scoreSalt, setScoreSalt } from './owner.js';

import * as ComplianceRegistry from '../build/ComplianceRegistry/contract/index.js';
import * as ComplianceEscrow from '../build/ComplianceEscrow/contract/index.js';
import * as PaymentGateway from '../build/PaymentGateway/contract/index.js';
import * as FeeDistributor from '../build/FeeDistributor/contract/index.js';
import * as TrustStackRegistry from '../build/TrustStackRegistry/contract/index.js';
import * as LegalSourceManifest from '../build/LegalSourceManifest/contract/index.js';
import * as SolvencyRegistry from '../build/SolvencyRegistry/contract/index.js';

// @ts-expect-error WebSocket polyfill required for wallet sync (graphql-ws) in Node
globalThis.WebSocket = WebSocket;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoFile = (f: string) => path.resolve(ROOT, f);
const buildPath = (name: string) => path.resolve(ROOT, 'build', name);
const hhmmss = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── byte helpers ────────────────────────────────────────────────────────────
function b32(s: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(buf, 0, 0, Math.min(s.length, 32));
  return new Uint8Array(buf);
}
function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`hexToBytes32: expected 64 hex chars, got ${clean.length}`);
  return new Uint8Array(Buffer.from(clean, 'hex'));
}
// Anti-replay context = sha256(org || jurisdiction || fresh-nonce); a fresh nonce keeps the loop repeatable.
function deriveContext(org: string, jurisdiction: string, nonce?: string): Uint8Array {
  const n = nonce ?? randomBytes(16).toString('hex');
  return new Uint8Array(createHash('sha256').update(`${org}||${jurisdiction}||${n}`).digest());
}

const dustOf = dustBalance;

// Watchdog: pace attestations to the agent's own DUST regeneration.
async function ensureDustFloor(ctx: V9Wallet, floor: bigint, maxWaitMs = 10 * 60_000): Promise<bigint> {
  let bal = dustOf(await Rx.firstValueFrom(ctx.facade.state()));
  if (bal >= floor) return bal;
  console.log(`[watchdog] DUST ${bal} < floor ${floor} — pausing for regeneration from registered NIGHT...`);
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const sub = ctx.facade.state().pipe(Rx.throttleTime(15_000)).subscribe((s: any) => {
      const b = dustOf(s);
      const el = Date.now() - start;
      console.log(`  [watchdog ${hhmmss()}] DUST ${b} (need ${floor}, ${Math.round(el / 1000)}s)`);
      if (b >= floor || el >= maxWaitMs) { sub.unsubscribe(); resolve(); }
    });
  });
  bal = dustOf(await Rx.firstValueFrom(ctx.facade.state()));
  if (bal < floor) throw new Error(`DUST still ${bal} < floor ${floor} after ${Math.round(maxWaitMs / 1000)}s: register more NIGHT for DUST generation`);
  return bal;
}

// (B) real value release: unshielded NIGHT transfer, gated by the on-chain verdict.
async function transferNight(ctx: V9Wallet, beneficiary: string, amount: bigint): Promise<string> {
  // The facade wants an UnshieldedAddress instance, not the bech32 string; decoding also rejects
  // an address from another network before anything is signed.
  const receiverAddress = MidnightBech32m.parse(beneficiary).decode(UnshieldedAddress, ctx.net.networkId as any);
  const recipe = await ctx.facade.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: ledger.unshieldedToken().raw, receiverAddress, amount }] }],
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await ctx.facade.signRecipe(recipe, (p: Uint8Array) => ctx.keystore.signDataAsync(p));
  return String(await ctx.facade.submitTransaction(await ctx.facade.finalizeRecipe(signed)));
}

// ── Contract bindings ────────────────────────────────────────────────────────
function deploymentAddress(network: string, name: string): string {
  const file = repoFile(`deployment-${network}-v9.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} missing: deploy with scripts/deploy-v9.ts first`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8')).contracts?.[name];
  if (!c?.contractAddress) throw new Error(`${name} not in ${file}`);
  if (c.accessControl !== 'owner-v2') throw new Error(`${name} in ${file} was deployed without access control or with the untagged owner_commitment (owner-v1); redeploy`);
  if (V10_CONTRACTS.has(name) && c.codeVersion !== CODE_VERSION) throw new Error(`${name} in ${file} is the pre-${CODE_VERSION} layout; redeploy with scripts/deploy-v9.ts`);
  return c.contractAddress;
}

async function joinContract(ctx: V9Wallet, secret: Uint8Array, name: string, mod: any) {
  const zkPath = buildPath(name);
  const compiled = (CompiledContract.make(name, mod.Contract) as any).pipe(
    (CompiledContract as any).withWitnesses(ownerWitnesses(secret)),
    (CompiledContract as any).withCompiledFileAssets(zkPath),
  );
  const addr = deploymentAddress(ctx.net.name, name);
  console.log(`[agent] joining ${name} ${addr.slice(0, 16)}…`);
  return (findDeployedContract as any)(makeProviders(ctx, zkPath, `${name}-agent`), {
    contractAddress: addr, compiledContract: compiled,
    privateStateId: `${name}PrivateState`, initialPrivateState: {},
  });
}

type QueueItem = {
  type?: 'use_case' | 'compliance' | 'escrow_create' | 'escrow_release' | 'escrow_refund' | 'trust_register' | 'legal_anchor' | 'solvency_seal';
  // use_case
  use_case_id?: string; verdict?: number; evidence_hash?: string; metadata_hash?: string;
  // compliance (score-private)
  company_id?: string; agent_did?: string; policy_cid?: string; threshold?: number; score?: number;
  org?: string; jurisdiction?: string;
  // escrow (conditional payment)
  escrow_id?: string; payer_id?: string; beneficiary_id?: string; amount?: number;
  // (B) real value release: on escrow_release, after the verdict gate passes, transfer NIGHT.
  beneficiary_address?: string; transfer_amount?: number | string;
  // (5) shared ZK trust stack + legal corpus
  stack_id?: string; stack_hash?: string; version?: number; citation_id?: string; source_hash?: string;
  // (PoR) solvency seal — reserves/liabilities are PRIVATE inputs (proven, NEVER written on-chain)
  entity_id?: string; report_cid?: string; period?: number; reserves?: number | string; liabilities?: number | string;
};

type Contracts = { cr: any; escrow: any; pg: any; fd: any; trust: any; legal: any; solvency: any; ownerSecret: Uint8Array };

// (2b) revenue recognition: book the per-attestation fee on-chain (PaymentGateway treasury = the
// public revenue ledger) + the 40/60 expert/auditor split (FeeDistributor). Real value-in is EARN
// (client→agent NIGHT, proven separately); this is the on-chain ACCOUNTING tied to real attestations.
async function bookRevenue(c: Contracts, fee: number): Promise<{ treasuryTx?: string; splitTx?: string }> {
  const dep = await c.pg.callTx.depositToTreasury(BigInt(fee));
  const split = await c.fd.callTx.distributeComplianceFee(40n, 60n);   // 40*3 == 60*2 invariant
  return { treasuryTx: dep?.public?.txId, splitTx: split?.public?.txId };
}
function appendRevenue(entry: any) {
  const p = repoFile('agent-revenue.json');
  const arr = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  arr.push(entry); fs.writeFileSync(p, JSON.stringify(arr, null, 2));
}

async function attestItem(c: Contracts, item: QueueItem) {
  const type = item.type ?? (item.score !== undefined ? 'compliance' : 'use_case');

  // ── ComplianceEscrow: conditional payment gated on a ZK attestation ──
  if (type === 'escrow_create') {
    const r = await c.escrow.callTx.createEscrow(
      b32(item.escrow_id!), b32(item.payer_id ?? item.org ?? 'payer'),
      b32(item.beneficiary_id ?? 'beneficiary'), BigInt(item.amount ?? 1),
      b32(item.use_case_id ?? 'usecase_v1'),
    );
    return { kind: 'escrow_create', key: item.escrow_id, public: r?.public ?? {} };
  }
  if (type === 'escrow_release') {
    const ctxBytes = deriveContext(item.org ?? 'org', item.jurisdiction ?? 'NA');
    const ev = item.evidence_hash
      ? hexToBytes32(item.evidence_hash)
      : new Uint8Array(createHash('sha256').update(`escrow-evidence||${item.escrow_id}`).digest());
    const r = await c.escrow.callTx.attestAndRelease(
      b32(item.escrow_id!), ev, BigInt(item.threshold ?? 70), ctxBytes, BigInt(item.score ?? 0),
    );
    return { kind: 'escrow_release', key: item.escrow_id, context: toHex(ctxBytes), public: r?.public ?? {} };
  }
  if (type === 'escrow_refund') {
    const r = await c.escrow.callTx.refundEscrow(b32(item.escrow_id!));
    return { kind: 'escrow_refund', key: item.escrow_id, public: r?.public ?? {} };
  }

  // ── (5) Shared ZK Trust Stack + Legal Corpus ──
  if (type === 'trust_register') {
    const r = await c.trust.callTx.registerStack(b32(item.stack_id!), hexToBytes32(item.stack_hash!), BigInt(item.version ?? 1));
    return { kind: 'trust_register', key: item.stack_id, public: r?.public ?? {} };
  }
  if (type === 'legal_anchor') {
    const r = await c.legal.callTx.anchorSource(b32(item.citation_id!), hexToBytes32(item.source_hash!), b32(item.jurisdiction ?? 'NA'));
    return { kind: 'legal_anchor', key: item.citation_id, public: r?.public ?? {} };
  }

  // ── (PoR) SolvencyRegistry: prove reserves >= liabilities WITHOUT disclosing either amount ──
  if (type === 'solvency_seal') {
    const entity = item.entity_id ?? item.org ?? 'entity';
    const ctxBytes = deriveContext(entity, `solvency:${item.period ?? 0}`);
    const rcClean = (item.report_cid ?? '').replace(/^0x/, '');
    const reportCid = /^[0-9a-fA-F]{64}$/.test(rcClean) ? hexToBytes32(item.report_cid!) : b32(item.report_cid ?? 'reserve-report-cid');
    const r = await c.solvency.callTx.sealSolvency(
      b32(entity), reportCid, ctxBytes, BigInt(item.period ?? 0),
      BigInt(item.reserves ?? 0), BigInt(item.liabilities ?? 0),
    );
    return { kind: 'solvency_seal', key: entity, context: toHex(ctxBytes), public: r?.public ?? {} };
  }

  // ── ComplianceRegistry: attestation ──
  if (type === 'compliance') {
    const org = item.org ?? item.company_id ?? 'org';
    const ctxBytes = deriveContext(org, item.jurisdiction ?? 'NA');
    // evidence_hash is recorded on-chain next to the verdict; no evidence, no attestation.
    if (!item.evidence_hash) throw new Error('compliance item needs evidence_hash (sha256 of the evaluation behind the score)');
    // score_commit = persistentCommit(score, salt); the salt is re-derivable from the owner secret + context.
    setScoreSalt(scoreSalt(c.ownerSecret, ctxBytes));
    let r: any;
    try {
      r = await c.cr.callTx.attestCompliance(
        b32(item.company_id ?? org), b32(item.agent_did ?? 'did:dpo2u:agent:001'),
        b32(item.policy_cid ?? 'bafy-policy-cid'), BigInt(item.threshold ?? 70),
        ctxBytes, BigInt(item.score ?? 0), hexToBytes32(item.evidence_hash),
      );
    } finally { setScoreSalt(undefined); }
    return { kind: 'compliance', key: item.company_id ?? org, context: toHex(ctxBytes), public: r?.public ?? {} };
  }
  const r = await c.cr.callTx.attestUseCase(
    b32(item.use_case_id ?? 'usecase_v1'), BigInt(item.verdict ?? 1),
    hexToBytes32(item.evidence_hash!), hexToBytes32(item.metadata_hash ?? item.evidence_hash!),
  );
  return { kind: 'use_case', key: item.evidence_hash, public: r?.public ?? {} };
}

// ── queue + ledger (file-backed, crash-safe drain) ──────────────────────────
function loadQueue(p: string): QueueItem[] {
  if (!fs.existsSync(p)) return [];
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.items ?? []); }
  catch (e) { console.log(`[queue] parse error: ${e}`); return []; }
}
function writeQueue(p: string, items: QueueItem[]) { fs.writeFileSync(p, JSON.stringify(items, null, 2)); }
function appendLedger(entry: any) {
  const p = repoFile('agent-ledger.json');
  const arr = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  arr.push(entry); fs.writeFileSync(p, JSON.stringify(arr, null, 2));
}

async function drainOnce(ctx: V9Wallet, contracts: Contracts, queuePath: string, floor: bigint, fee: number) {
  const items = loadQueue(queuePath);
  if (items.length === 0) { console.log('[agent] queue empty.'); return 0; }
  console.log(`[agent] draining ${items.length} item(s)...`);
  let done = 0;
  while (true) {
    const remaining = loadQueue(queuePath);
    const item = remaining.shift();
    if (!item) break;
    const label = item.escrow_id ?? item.use_case_id ?? item.company_id ?? '(item)';
    try {
      await ensureDustFloor(ctx, floor);                          // Phase-2 watchdog
      const before = dustOf(await Rx.firstValueFrom(ctx.facade.state()));
      const res = await attestItem(contracts, item);
      // (B) conditional payment: the verdict gate passed above → move real NIGHT to the beneficiary.
      let transferTx: string | null = null;
      if (res.kind === 'escrow_release' && item.beneficiary_address && item.transfer_amount != null) {
        transferTx = await transferNight(ctx, item.beneficiary_address, BigInt(item.transfer_amount));
        console.log(`  [agent] (B) released ${item.transfer_amount} NIGHT → ${String(item.beneficiary_address).slice(0, 22)}… tx ${transferTx}`);
      }
      // (2b) revenue recognition: priced attestations book the fee on-chain + the 40/60 split.
      let revenue: { treasuryTx?: string; splitTx?: string } | null = null;
      if ((res.kind === 'use_case' || res.kind === 'compliance') && fee > 0) {
        revenue = await bookRevenue(contracts, fee);
        console.log(`  [agent] (2b) revenue: fee ${fee} → PaymentGateway treasury + FeeDistributor 40/60 (tx ${revenue.treasuryTx})`);
      }
      const after = dustOf(await Rx.firstValueFrom(ctx.facade.state()));
      const cost = before - after;
      writeQueue(queuePath, remaining);                          // drop processed (idempotent)
      appendLedger({
        ts: new Date().toISOString(), network: ctx.net.name, kind: res.kind, key: res.key,
        txId: (res.public as any).txId, blockHeight: (res.public as any).blockHeight,
        transferTx, transferAmount: transferTx ? String(item.transfer_amount) : undefined,
        dustBefore: before.toString(), dustAfter: after.toString(), dustCost: cost.toString(),
        context: (res as any).context,
      });
      if (revenue) appendRevenue({ ts: new Date().toISOString(), kind: res.kind, key: res.key, fee, treasuryTx: revenue.treasuryTx, splitTx: revenue.splitTx, dustCost: cost.toString() });
      done++;
      console.log(`[agent] ✓ ${res.kind} ${label} → tx ${(res.public as any).txId} (block ${(res.public as any).blockHeight}); DUST cost ${cost}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.log(`[agent] ✗ ${label} FAILED: ${msg}`);
      // leave the item in the queue head; abort this drain so a poison item can't spin.
      appendLedger({ ts: new Date().toISOString(), network: ctx.net.name, key: label, error: msg });
      break;
    }
  }
  console.log(`[agent] drain complete: ${done} sealed.`);
  return done;
}

async function main() {
  const { values } = parseArgs({
    options: {
      queue: { type: 'string', default: 'agent-queue.json' },
      'dust-floor': { type: 'string', default: '1000000000000000' }, // 1e15
      once: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string', default: '120' },
      fee: { type: 'string', default: '10' },   // (2b) per-attestation fee booked on-chain (0 disables)
    },
  });
  const net = networkConfig();
  const queuePath = repoFile(String(values.queue));
  const floor = BigInt(String(values['dust-floor']));
  const watch = Boolean(values.watch);
  const intervalMs = Math.max(15, Number(values.interval)) * 1000;
  const secret = ownerSecret(masterSeedHex());

  console.log('='.repeat(64));
  console.log(`  DPO2U Midnight autonomous agent — ${net.name} (ledger v9)`);
  console.log(`  queue: ${queuePath} | dust-floor: ${floor} | mode: ${watch ? 'watch' : 'once'}`);
  console.log('='.repeat(64));

  const ctx = await openWallet(net);
  await ensureDust(ctx);

  const contracts: Contracts = {
    ownerSecret: secret,
    cr: await joinContract(ctx, secret, 'ComplianceRegistry', ComplianceRegistry),
    escrow: await joinContract(ctx, secret, 'ComplianceEscrow', ComplianceEscrow),
    pg: await joinContract(ctx, secret, 'PaymentGateway', PaymentGateway),
    fd: await joinContract(ctx, secret, 'FeeDistributor', FeeDistributor),
    trust: await joinContract(ctx, secret, 'TrustStackRegistry', TrustStackRegistry),
    legal: await joinContract(ctx, secret, 'LegalSourceManifest', LegalSourceManifest),
    solvency: await joinContract(ctx, secret, 'SolvencyRegistry', SolvencyRegistry),
  };
  const fee = Number(values.fee);

  do {
    await drainOnce(ctx, contracts, queuePath, floor, fee);
    if (watch) { console.log(`[agent] sleeping ${intervalMs / 1000}s...`); await sleep(intervalMs); }
  } while (watch);

  try { await ctx.facade.stop?.(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => { console.error('\nAgent failed:', err); process.exit(1); });
