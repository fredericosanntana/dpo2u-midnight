/**
 * Operate the TravelRuleGate v10 on a network (preview | preprod | mainnet), with its on-chain
 * calls to PsavPassport and ComplianceRegistry wired through midnight-js-contracts 5.
 *
 *   MIDNIGHT_NETWORK=preview npx tsx scripts/travel-rule-v10.ts <command> [options] [--plan]
 *
 * Commands (addresses from deployment-<net>-v9.json, gate must be codeVersion v10):
 *   attest-self     ComplianceRegistry.attestCompliance for TRAVEL_RULE_SELF_COMPANY_ID
 *                   --score N (private) --threshold N --context LABEL --evidence HEX|LABEL
 *   issue-passport  PsavPassport.issuePassport, tier 0 (machine-only), one machine rule PASS
 *                   --passport-id ID (= the counterparty vasp_id) [--pack LABEL --pack-version V]
 *   register-provider  registerSanctionsProvider --provider-id ID --provider-key FILE ({x, y} decimal; re-registering rotates)
 *   revoke-provider    revokeSanctionsProvider --provider-id ID
 *   evaluate        evaluateTransfer --transfer ID --policy HEX|LABEL --witness-file FILE(600) --sanctions-list FILE|-
 *                   (signed list payload, docs/TRAVEL-RULE-DISCLOSURE.md; '-' reads it from stdin)
 *   release         releaseTransfer --transfer ID
 *   grant           grantDisclosure --grant ID --transfer ID --supervisor ID --scope N --ttl SEC --purpose HEX|LABEL
 *   approve         approveDisclosure --grant ID   (approver key: DPO2U_APPROVER_SECRET on testnets,
 *                   --approver-secret-stdin on mainnet; never the owner secret)
 *                   --as-owner tries with the OWNER secret, to show it is refused (never succeeds)
 *   revoke          revokeDisclosure --grant ID
 *   status          ledger read: transfer status / grant activity  [--transfer ID] [--grant ID]
 *
 * --deployment FILE reads the addresses from FILE instead of deployment-<net>-v9.json.
 * --plan prints what would run (contract, circuit, key, cross-contract call, ZK sources, args) and
 * touches no wallet and no network. Output: one JSON line on stdout; a reverted circuit prints
 * { ok: false, error } and exits 2. The owner secret comes from scripts/owner.ts (DPO2U_OWNER_SECRET
 * or derived from the seed on testnets); mainnet keeps the guard of scripts/lib/midnight-v9.ts.
 * Witness files hold hashes and salts only (format: scripts/lib/travel-rule-v10.ts TransferWitness).
 */
import 'dotenv/config';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { encodeContractAddress, ContractState } from '@midnight-ntwrk/compact-runtime';
import fs from 'node:fs';
import { fromPayload } from './lib/sanctions-list.js';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { networkConfig, openWallet, ensureDust, makeProviders, masterSeedHex, type V9Wallet } from './lib/midnight-v9.js';
import { ownerSecret, scoreSalt, setScoreSalt, ownerWitnesses } from './owner.js';
import {
  GATE, COMMANDS, type Command, type CalleeName, readGateDeployment, moduleProviderFor, zkDirs, buildDir,
  b32, hashArg, idArg, hex, readTransferWitness, resolveApproverSecret, checkApproverAgainstLedger, grantStatus, plan, gateLedgerOf, parseProviderKey,
} from './lib/travel-rule-v10.js';

// @ts-expect-error WebSocket polyfill for graphql-ws in Node
globalThis.WebSocket = WebSocket;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: 'boolean', default: false }, deployment: { type: 'string' },
    transfer: { type: 'string' }, policy: { type: 'string' }, 'witness-file': { type: 'string' },
    grant: { type: 'string' }, supervisor: { type: 'string' }, scope: { type: 'string' }, ttl: { type: 'string' }, purpose: { type: 'string' },
    'approver-secret-stdin': { type: 'boolean', default: false }, 'as-owner': { type: 'boolean', default: false },
    'sanctions-list': { type: 'string' }, 'provider-id': { type: 'string' }, 'provider-key': { type: 'string' },
    score: { type: 'string' }, threshold: { type: 'string' }, context: { type: 'string' }, evidence: { type: 'string' },
    'passport-id': { type: 'string' }, pack: { type: 'string' }, 'pack-version': { type: 'string' },
  },
});

const cmd = positionals[0] as Command;
if (!COMMANDS.includes(cmd)) { console.error(`usage: travel-rule-v10.ts <${COMMANDS.join('|')}> [options] [--plan]`); process.exit(64); }
const need = (k: keyof typeof values): string => { const v = values[k]; if (typeof v !== 'string' || !v) throw new Error(`--${k} is required for ${cmd}`); return v; };
const selfCompany = () => { const s = (process.env.TRAVEL_RULE_SELF_COMPANY_ID ?? '').trim(); if (!s) throw new Error('TRAVEL_RULE_SELF_COMPANY_ID is required (same value the gate was deployed with)'); return s; };
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };

/** Arguments for the command, printable (hex) and as circuit values. */
function argsFor(c: Command): { show: Record<string, unknown>; call: unknown[] } {
  switch (c) {
    case 'attest-self': {
      const company = b32(selfCompany()), ctx = hashArg(need('context')), ev = hashArg(need('evidence'));
      return { show: { company_id: hex(company), threshold: need('threshold'), context: hex(ctx), evidence_hash: hex(ev), score: '(private)' },
        call: [company, b32('did:dpo2u:agent:001'), b32('travel-rule-v10'), BigInt(need('threshold')), ctx, BigInt(need('score')), ev] };
    }
    case 'issue-passport': {
      const id = idArg(need('passport-id')), issued = Math.floor(Date.now() / 1000) - 120;
      return { show: { passport_id: hex(id), tier: 0, issued_at: issued, expires_at: issued + 31_536_000 },
        call: [id, hashArg(values.pack ?? 'psav-pack-fictitious'), b32(values['pack-version'] ?? '1.0.0'), 0n, BigInt(issued), BigInt(issued + 31_536_000)] };
    }
    case 'evaluate': {
      const t = idArg(need('transfer')), p = hashArg(need('policy'));
      need('witness-file'); need('sanctions-list');
      return { show: { transfer_id: hex(t), policy_hash: hex(p), witness_file: values['witness-file'], sanctions_list: values['sanctions-list'] }, call: [t, p] };
    }
    case 'release': { const t = idArg(need('transfer')); return { show: { transfer_id: hex(t) }, call: [t] }; }
    case 'grant': {
      const g = idArg(need('grant')), t = idArg(need('transfer')), s = idArg(need('supervisor')), p = hashArg(need('purpose'));
      const exp = Math.floor(Date.now() / 1000) + Number(values.ttl ?? 3600);
      return { show: { grant_id: hex(g), transfer_id: hex(t), supervisor_id: hex(s), scope: Number(need('scope')), expires_at: exp, purpose_hash: hex(p) },
        call: [g, t, s, BigInt(need('scope')), BigInt(exp), p] };
    }
    case 'approve': case 'revoke': { const g = idArg(need('grant')); return { show: { grant_id: hex(g) }, call: [g] }; }
    case 'register-provider': {
      const id = idArg(need('provider-id')), key = parseProviderKey(JSON.parse(fs.readFileSync(need('provider-key'), 'utf8')));
      return { show: { provider_id: hex(id), key: { x: key.x.toString(), y: key.y.toString() } }, call: [id, key] };
    }
    case 'revoke-provider': { const id = idArg(need('provider-id')); return { show: { provider_id: hex(id) }, call: [id] }; }
    case 'status': return { show: { transfer: values.transfer ?? null, grant: values.grant ?? null }, call: [] };
  }
}

/** Providers for a gate call: module provider for the callees + ZK registry over gate and callees. */
function crossProviders(w: V9Wallet, links: Record<CalleeName, string>) {
  const base = makeProviders(w, buildDir(ROOT, GATE), `${GATE}-v10`);
  const registry = new ZKConfigRegistry(zkDirs(ROOT).map((d) => new NodeZkConfigProvider(d)));
  return { ...base, contractModuleProvider: moduleProviderFor(ROOT, links), proofProvider: httpClientProofProvider({ url: w.net.proofServer, zkConfigProvider: registry } as any) };
}

async function join(providers: any, name: string, address: string, witnesses: Record<string, unknown>) {
  const zk = buildDir(ROOT, name);
  const mod = await import(pathToFileURL(path.join(zk, 'contract', 'index.js')).href);
  const compiled = (CompiledContract.make(name, mod.Contract) as any).pipe(
    (CompiledContract as any).withWitnesses(witnesses), (CompiledContract as any).withCompiledFileAssets(zk));
  const c = await (findDeployedContract as any)(providers, { contractAddress: address, compiledContract: compiled, privateStateId: `${name}PrivateState`, initialPrivateState: {} });
  return { c, mod };
}

const refuse = (n: string) => () => { throw new Error(`witness ${n} is not available to ${cmd}`); };

async function main() {
  const net = networkConfig();
  const d = readGateDeployment(ROOT, net.name, values.deployment);
  const a = argsFor(cmd);
  const p = plan(ROOT, d, cmd, a.show);
  if (values.plan) { console.log(JSON.stringify({ plan: p }, null, 2)); return; }

  const approverSecret = cmd !== 'approve' ? undefined
    : values['as-owner'] ? ownerSecret(masterSeedHex())
    : resolveApproverSecret(net.name, { env: process.env.DPO2U_APPROVER_SECRET, stdin: values['approver-secret-stdin'] ? await readStdin() : undefined });
  const w = await openWallet(net);
  try {
    if (cmd !== 'status' && (await ensureDust(w)) === 0n) throw new Error('No DUST in the wallet');
    const Gate = await import(pathToFileURL(path.join(buildDir(ROOT, GATE), 'contract', 'index.js')).href);
    const providers = crossProviders(w, d.links);
    const readGate = async () => gateLedgerOf(Gate, await providers.publicDataProvider.queryContractState(d.gate), ContractState);

    // The gate's on-chain links must be the addresses we resolve modules for.
    const L0 = await readGate();
    for (const [field, name] of [['passport', 'PsavPassport'], ['registry', 'ComplianceRegistry']] as const) {
      const onchain = hex(L0[field].bytes), expected = hex(encodeContractAddress(d.links[name]));
      if (onchain !== expected) throw new Error(`gate.${field} on chain (${onchain.slice(0, 12)}…) differs from ${d.file} (${expected.slice(0, 12)}…)`);
    }

    if (cmd === 'status') {
      const now = Math.floor(Date.now() / 1000);
      const out: any = { gate: d.gate, totals: { pass: String(L0.total_pass), fail: String(L0.total_fail), released: String(L0.total_released), grants: String(L0.total_grants) } };
      if (values.transfer) {
        const t = idArg(values.transfer);
        out.transfer = L0.status.member(t)
          ? { status: Number(L0.status.lookup(t)), fail_reason: Number(L0.fail_reason.lookup(t)), policy_hash: hex(L0.verdict_policy.lookup(t)),
              sanctions: { list_root: hex(L0.verdict_sanctions_root.lookup(t)), provider_id: hex(L0.verdict_sanctions_provider.lookup(t)), valid_until: Number(L0.verdict_sanctions_valid_until.lookup(t)) } }
          : { status: 0 };
      }
      if (values.grant) out.grant = grantStatus(L0, idArg(values.grant), now);
      console.log(JSON.stringify({ ok: true, ...out }));
      return;
    }

    const owner = cmd === 'approve' ? undefined : ownerSecret(masterSeedHex());
    if (approverSecret) {
      try { checkApproverAgainstLedger(Gate, approverSecret, L0); }
      catch (e: any) { console.log(JSON.stringify({ ok: false, command: cmd, circuit: p.circuit, error: e.message })); process.exitCode = 2; return; }
    }

    let target: any;
    if (cmd === 'attest-self' || cmd === 'issue-passport') {
      const name = cmd === 'attest-self' ? 'ComplianceRegistry' : 'PsavPassport';
      const base = makeProviders(w, buildDir(ROOT, name), `${name}-v10`);
      const w8 = { ...ownerWitnesses(owner!),
        rule_origins: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]], rule_verdicts: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]],
        partner_id: (x: any) => [x.privateState, b32('fictitious-partner')], commit_salt: (x: any) => [x.privateState, new Uint8Array(randomBytes(32))],
        reviewer_sig_hash: (x: any) => [x.privateState, new Uint8Array(32)], evidence_hash: (x: any) => [x.privateState, hashArg('fictitious-evidence')],
        sponsor_secret: refuse('sponsor_secret') };
      target = (await join(base, name, d.links[name as CalleeName], w8)).c;
      if (cmd === 'attest-self') setScoreSalt(scoreSalt(owner!, a.call[4] as Uint8Array));
    } else {
      const wit = cmd === 'evaluate' ? readTransferWitness(values['witness-file']!) : undefined;
      const list = cmd === 'evaluate' ? fromPayload(JSON.parse(values['sanctions-list'] === '-' ? await readStdin() : fs.readFileSync(values['sanctions-list']!, 'utf8'))) : undefined;
      target = (await join(providers, GATE, d.gate, {
        owner_secret: owner ? (x: any) => [x.privateState, owner] : refuse('owner_secret'),
        approver_secret: approverSecret ? (x: any) => [x.privateState, approverSecret] : refuse('approver_secret'),
        originator_data: wit ? (x: any) => [x.privateState, wit.o] : refuse('originator_data'),
        beneficiary_data: wit ? (x: any) => [x.privateState, wit.b] : refuse('beneficiary_data'),
        transfer_amount: wit ? (x: any) => [x.privateState, wit.amount] : refuse('transfer_amount'),
        sanctions_clear: wit ? (x: any) => [x.privateState, wit.clear] : refuse('sanctions_clear'),
        sanctions_list: list ? (x: any) => [x.privateState, list] : refuse('sanctions_list'),
      })).c;
    }

    const circuit = p.circuit;
    let r: any;
    try {
      r = await target.callTx[circuit](...a.call);
    } catch (e: any) {
      console.log(JSON.stringify({ ok: false, command: cmd, circuit, error: String(e?.message ?? e).slice(0, 400) }));
      process.exitCode = 2;
      return;
    } finally { setScoreSalt(undefined); }

    const L = await readGate();
    const after: any = {};
    if (cmd === 'evaluate' || cmd === 'release') {
      const t = a.call[0] as Uint8Array;
      after.transfer = { status: Number(L.status.lookup(t)), fail_reason: Number(L.fail_reason.lookup(t)), policy_hash: hex(L.verdict_policy.lookup(t)),
        sanctions: { list_root: hex(L.verdict_sanctions_root.lookup(t)), provider_id: hex(L.verdict_sanctions_provider.lookup(t)), valid_until: Number(L.verdict_sanctions_valid_until.lookup(t)) } };
    }
    if (cmd === 'register-provider' || cmd === 'revoke-provider') {
      const id = a.call[0] as Uint8Array;
      after.provider = { registered: L.sanctions_provider_key.member(id), revoked: L.sanctions_provider_revoked.member(id) };
    }
    if (cmd === 'grant' || cmd === 'approve' || cmd === 'revoke') after.grant = grantStatus(L, a.call[0] as Uint8Array, Math.floor(Date.now() / 1000));
    console.log(JSON.stringify({ ok: true, command: cmd, contract: p.contract, address: p.address, circuit, result: r?.private?.result === undefined ? null : String(r.private.result),
      txId: r?.public?.txId, blockHeight: r?.public?.blockHeight, ...after }));
  } finally {
    await (w.facade as any).stop?.();
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
