/**
 * TravelRuleGate v10 on a network: the pure part (no wallet, no network), unit-tested.
 *
 * The v10 gate calls PsavPassport.isValid (evaluateTransfer) and ComplianceRegistry.hasAttestation
 * (releaseTransfer) on chain. midnight-js-contracts 5 runs those calls when the providers carry:
 *   - contractModuleProvider: callee address -> generated module (build/<name>/contract/index.js);
 *     the SDK pins the callee states to the same block it reads the gate at, via the indexer.
 *   - a proof provider whose key source is a ZKConfigRegistry over the gate AND the callees, so the
 *     proof server gets the callees' proving keys too (one proof per call in the transaction).
 * This module builds those, reads the addresses from deployment-<net>-v9.json, encodes the
 * circuit arguments, resolves the approver key, and prints the plan (--plan) without a network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CODE_VERSION } from './midnight-v9.js';
import { institutionGate } from './institutions.js';

export const GATE = 'TravelRuleGate';
export const CALLEES = ['PsavPassport', 'ComplianceRegistry'] as const;
export type CalleeName = (typeof CALLEES)[number];

export type GateDeployment = {
  network: string;
  gate: string;
  links: Record<CalleeName, string>;
  file: string;
  institution?: string;
};

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Gate + linked addresses from deployment-<net>-v9.json; refuses a pre-v10 gate or missing links. */
export function readGateDeployment(root: string, network: string, fileOverride?: string, institution?: string): GateDeployment {
  const file = fileOverride ? path.resolve(fileOverride) : path.join(root, `deployment-${network}-v9.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} missing: deploy with scripts/deploy-v9.ts first`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const contracts = json.contracts ?? {};
  // --institution <id>: that institution's own gate (institutions.<id>.TravelRuleGate); the callees stay shared.
  const g = institution ? institutionGate(json, institution) : contracts[GATE];
  if (!g?.contractAddress) throw new Error(institution ? `institution ${institution} has no ${GATE} in ${file} (deploy-v9.ts --institution ${institution})` : `${GATE} not in ${file}`);
  if (g.codeVersion !== CODE_VERSION) throw new Error(`${GATE} in ${file} is the pre-${CODE_VERSION} layout (no PsavPassport/ComplianceRegistry link); redeploy with scripts/deploy-v9.ts`);
  const links = {} as Record<CalleeName, string>;
  for (const n of CALLEES) {
    const a = g.links?.[n] ?? contracts[n]?.contractAddress;
    if (!a || !HEX64.test(a)) throw new Error(`${GATE} link to ${n} missing in ${file}`);
    links[n] = a.toLowerCase();
  }
  return { network, gate: String(g.contractAddress).toLowerCase(), links, file, ...(institution ? { institution } : {}) };
}

export const buildDir = (root: string, name: string) => path.join(root, 'build', name);

/** contractModuleProvider for the SDK: only the gate's linked callees resolve; anything else is undefined. */
export function moduleProviderFor(root: string, links: Record<CalleeName, string>) {
  const byAddr = new Map(Object.entries(links).map(([name, addr]) => [addr.toLowerCase(), name]));
  return {
    resolve: (address: string) => {
      const name = byAddr.get(String(address).toLowerCase());
      if (!name) return undefined;
      return async () => import(pathToFileURL(path.join(buildDir(root, name), 'contract', 'index.js')).href);
    },
  };
}

/** The ZK artifact directories the proof server needs: the gate's and each callee's. */
export function zkDirs(root: string): string[] {
  return [GATE, ...CALLEES].map((n) => buildDir(root, n));
}

// ── arguments ──
/** Same 32-byte padding as scripts/agent.ts b32 (company ids, grant ids, transfer ids). */
export function b32(s: string): Uint8Array {
  const b = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(b, 0, 0, Math.min(Buffer.byteLength(s), 32));
  return new Uint8Array(b);
}
/** 64 hex chars -> those 32 bytes; anything else -> sha256(label). For policy / purpose hashes. */
export function hashArg(v: string): Uint8Array {
  if (HEX64.test(v)) return new Uint8Array(Buffer.from(v, 'hex'));
  return new Uint8Array(createHash('sha256').update(v).digest());
}
/** 64 hex chars -> those bytes; otherwise the b32 padding of the label. For transfer / grant / supervisor ids. */
export function idArg(v: string): Uint8Array {
  return HEX64.test(v) ? new Uint8Array(Buffer.from(v, 'hex')) : b32(v);
}
export const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

// ── private transfer data (evaluateTransfer witnesses) ──
export type PartyIn = { name_hash: string; account_hash: string; doc_hash: string; vasp_id: string; salt: string };
export type TransferWitness = { originator: PartyIn; beneficiary: PartyIn; amount_cents: string | number; sanctions_clear: boolean };
export type PartyBytes = { name_hash: Uint8Array; account_hash: Uint8Array; doc_hash: Uint8Array; vasp_id: Uint8Array; salt: Uint8Array };

/** Reads the transfer's private data (hashes and salts, never raw PII) from a mode-600 JSON file. */
export function readTransferWitness(file: string): { o: PartyBytes; b: PartyBytes; amount: bigint; clear: boolean } {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} holds private transfer data: it must be mode 600`);
  return parseTransferWitness(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function parseTransferWitness(j: TransferWitness): { o: PartyBytes; b: PartyBytes; amount: bigint; clear: boolean } {
  const party = (p: PartyIn, who: string): PartyBytes => {
    const out: any = {};
    for (const k of ['name_hash', 'account_hash', 'doc_hash', 'vasp_id', 'salt'] as const) {
      const v = p?.[k];
      if (k === 'vasp_id') { out[k] = idArg(String(v ?? '')); continue; }
      if (!HEX64.test(String(v ?? ''))) throw new Error(`${who}.${k} must be 32 bytes of hex (a hash, never the raw value)`);
      out[k] = new Uint8Array(Buffer.from(String(v), 'hex'));
    }
    return out;
  };
  if (typeof j.sanctions_clear !== 'boolean') throw new Error('sanctions_clear must be true or false (result of the VASP screening)');
  const amount = BigInt(j.amount_cents);
  if (amount < 0n) throw new Error('amount_cents must be >= 0');
  return { o: party(j.originator, 'originator'), b: party(j.beneficiary, 'beneficiary'), amount, clear: j.sanctions_clear };
}

// ── approver key ──
/**
 * The approver signs approveDisclosure with its own secret, never the owner's.
 *   testnets: DPO2U_APPROVER_SECRET (env) or --approver-secret-stdin
 *   mainnet:  --approver-secret-stdin only (typed or piped from outside the VPS; never stored here)
 * Checks against the gate's public ledger: the secret must open approver_commit and must NOT open
 * owner_commit (a secret equal to the owner's is refused even if someone deployed it that way).
 */
export function resolveApproverSecret(network: string, src: { env?: string; stdin?: string }): Uint8Array {
  const fromStdin = (src.stdin ?? '').trim();
  const fromEnv = (src.env ?? '').trim();
  if (network === 'mainnet' && !fromStdin) throw new Error('Mainnet: pass the approver secret with --approver-secret-stdin (from outside the VPS), not from env or disk');
  const v = fromStdin || fromEnv;
  if (!v) throw new Error('Approver secret missing: DPO2U_APPROVER_SECRET (testnets) or --approver-secret-stdin');
  if (!HEX64.test(v)) throw new Error('Approver secret must be 32 bytes of hex');
  return new Uint8Array(Buffer.from(v, 'hex'));
}

export function checkApproverAgainstLedger(gate: any, secret: Uint8Array, L: { owner_commit: Uint8Array; approver_commit: Uint8Array }): void {
  if (Buffer.from(gate.pureCircuits.owner_commitment(secret)).equals(Buffer.from(L.owner_commit))) throw new Error('This is the owner secret: the owner cannot approve a disclosure');
  if (!Buffer.from(gate.pureCircuits.approver_commitment(secret)).equals(Buffer.from(L.approver_commit))) throw new Error('This secret does not open the gate approver_commit');
}

/** Gate ledger from a midnight-js 5 queryContractState read (serialized state -> ledger view). */
export function gateLedgerOf(Gate: any, read: any, ContractStateCls: any) {
  if (!read) throw new Error('no contract state at this address');
  return Gate.ledger(read.contractState.deserialize({ v9: ContractStateCls }).data);
}

/** Provider public key {x, y} (decimal strings or numbers) -> JubjubPoint. */
export function parseProviderKey(j: any): { x: bigint; y: bigint } {
  if (!/^\d+$/.test(String(j?.x)) || !/^\d+$/.test(String(j?.y))) throw new Error('provider key must be { "x": "<decimal>", "y": "<decimal>" }');
  return { x: BigInt(j.x), y: BigInt(j.y) };
}

/** Grant state from the public ledger (isGrantActive without a transaction). */
export function grantStatus(L: any, grantId: Uint8Array, nowSec: number) {
  const known = L.grant_scope.member(grantId);
  if (!known) return { known: false, approved: false, revoked: false, expired: false, active: false };
  const approved = L.grant_approved.member(grantId);
  const revoked = L.grant_revoked.member(grantId);
  const expires = Number(L.grant_expires.lookup(grantId));
  const expired = nowSec >= expires;
  return { known, approved, revoked, expired, expires_at: expires, scope: Number(L.grant_scope.lookup(grantId)), purpose_hash: hex(L.grant_purpose.lookup(grantId)), active: approved && !revoked && !expired };
}

// ── plan ──
export const COMMANDS = ['attest-self', 'issue-passport', 'register-provider', 'revoke-provider', 'evaluate', 'release', 'grant', 'approve', 'revoke', 'status'] as const;
export type Command = (typeof COMMANDS)[number];

const CONTRACT_OF: Record<Command, string> = {
  'attest-self': 'ComplianceRegistry', 'issue-passport': 'PsavPassport', 'register-provider': GATE, 'revoke-provider': GATE,
  evaluate: GATE, release: GATE, grant: GATE, approve: GATE, revoke: GATE, status: GATE,
};
const CIRCUIT_OF: Record<Command, string> = {
  'attest-self': 'attestCompliance', 'issue-passport': 'issuePassport', 'register-provider': 'registerSanctionsProvider', 'revoke-provider': 'revokeSanctionsProvider',
  evaluate: 'evaluateTransfer', release: 'releaseTransfer', grant: 'grantDisclosure', approve: 'approveDisclosure', revoke: 'revokeDisclosure', status: '(ledger read: isGrantActive)',
};
const CROSS_OF: Partial<Record<Command, string>> = {
  evaluate: 'PsavPassport.isValid(beneficiary vasp_id) when the VASP is not in attested_vasps; signed sanctions list checked in-circuit',
  release: 'ComplianceRegistry.hasAttestation(self_company_id) must be 1',
};
const KEY_OF: Record<Command, string> = {
  'attest-self': 'owner', 'issue-passport': 'owner', 'register-provider': 'owner', 'revoke-provider': 'owner', evaluate: 'owner', release: 'owner', grant: 'owner',
  approve: 'approver (own key, never the owner\'s)', revoke: 'owner', status: 'none (read only)',
};

export function plan(root: string, d: GateDeployment, cmd: Command, args: Record<string, unknown>) {
  const contract = CONTRACT_OF[cmd];
  const address = contract === GATE ? d.gate : d.links[contract as CalleeName];
  const crossContract = CROSS_OF[cmd];
  return {
    network: d.network, deployment: path.relative(root, d.file), command: cmd,
    contract, address, circuit: CIRCUIT_OF[cmd], key: KEY_OF[cmd],
    crossContract: crossContract ?? null,
    moduleProvider: crossContract ? Object.fromEntries(CALLEES.map((n) => [d.links[n], `build/${n}/contract/index.js`])) : null,
    zkSources: (crossContract ? zkDirs(root) : [buildDir(root, contract)]).map((p) => path.relative(root, p)),
    args,
  };
}
