/**
 * Shared simulator setup for the access-controlled contracts.
 *
 * Every contract takes owner_commit in its constructor and reads owner_secret from a witness.
 * The private state is { ownerSecret }, so a test can switch caller with asStranger(ctx).
 * Runtime-specific calls (compact-runtime 0.21 / compactc 0.36) live only in this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  createCircuitContext, createConstructorContext, dummyContractAddress,
  ContractOperation, ContractState, encodeContractAddress,
} from '@midnight-ntwrk/compact-runtime';

export type OwnerPS = { ownerSecret: Uint8Array; scoreSalt?: Uint8Array };

export const b32 = (s: string): Uint8Array => {
  const x = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(x, 0, 0, Math.min(Buffer.byteLength(s), 32));
  return new Uint8Array(x);
};

export const OWNER_SECRET = b32('dpo2u-owner-secret-test-only');
export const STRANGER_SECRET = b32('someone-else-entirely');
export const NOT_OWNER = /Only the contract owner can do this/;

export const SCORE_SALT = b32('score-salt-test-only');

// Superset of witnesses: contracts ignore the ones they do not declare (score_salt is ComplianceRegistry's).
const witnesses = {
  owner_secret: (c: any) => [c.privateState, (c.privateState as OwnerPS).ownerSecret] as [OwnerPS, Uint8Array],
  score_salt: (c: any) => [c.privateState, (c.privateState as OwnerPS).scoreSalt ?? SCORE_SALT] as [OwnerPS, Uint8Array],
};

const COIN_PK = '0'.repeat(64);

/** Deploys `ContractClass` in the simulator with OWNER_SECRET as owner; returns the contract and an owner context. */
export async function setupOwned<C = any>(ContractClass: any, pureCircuits: any, ...extraArgs: unknown[]): Promise<{ contract: C & any; ctx: any }> {
  const contract = new ContractClass(witnesses);
  const ps: OwnerPS = { ownerSecret: OWNER_SECRET };
  const commit = pureCircuits.owner_commitment(OWNER_SECRET);
  const { currentContractState } = await contract.initialState(createConstructorContext(ps, COIN_PK), commit, ...extraArgs);
  const ctx = createCircuitContext({
    circuitId: 'test',
    contractAddress: dummyContractAddress(),
    coinPublicKeyOrZswapState: COIN_PK,
    contractState: currentContractState,
    privateState: ps,
  });
  return { contract, ctx };
}

/** Same ledger state, but the caller holds a different secret. */
export function asStranger(ctx: any): any {
  return withPrivateState(ctx, { ownerSecret: STRANGER_SECRET });
}

export function withPrivateState(ctx: any, ps: OwnerPS): any {
  if (ctx?.callContext) return { ...ctx, callContext: { ...ctx.callContext, currentPrivateState: ps } };
  return { ...ctx, currentPrivateState: ps };
}

/**
 * Hex dump of the full public ledger state, for PRIVACY scans.
 *
 * In compact-runtime 0.21 String(state) renders values lazily ("<Lazy Sp>"), so it no longer
 * exposes the bytes. This walks the StateValue tree (cells, map keys and values, arrays,
 * Merkle-tree roots) and hex-encodes every Uint8Array of every AlignedValue.
 */
export function publicStateHex(state: any): string {
  const out: string[] = [];
  // Stored values trim trailing zero bytes; pad each Bytes<n> atom back to its declared length
  // (from the alignment) so a zero-padded raw field would still be found by the scan.
  const atoms = (al: any[]): any[] => al.flatMap((seg: any) => seg.tag === 'atom' ? [seg.value] : [null]);
  const av = (a: any) => {
    if (!a) return;
    const at = atoms(a.alignment);
    a.value.forEach((chunk: Uint8Array, i: number) => {
      const atom = at.length === a.value.length ? at[i] : null;
      const buf = Buffer.alloc(Math.max(chunk.length, atom?.tag === 'bytes' ? atom.length : 0));
      Buffer.from(chunk).copy(buf);
      out.push(buf.toString('hex'));
    });
  };
  const walk = (v: any): void => {
    if (!v) return;
    switch (v.type()) {
      case 'cell': av(v.asCell()); break;
      case 'map': { const m = v.asMap(); for (const k of m.keys()) { av(k); walk(m.get(k)); } break; }
      case 'array': for (const x of v.asArray()) walk(x); break;
      case 'boundedMerkleTree': av(v.asBoundedMerkleTree().root()); break;
      default: break;
    }
  };
  walk(state?.state ?? state);
  return out.join('|');
}

// ── Cross-contract calls in the simulator (compact-runtime 0.21) ──
// A callee must look deployed: a ContractState whose operations carry the verifier keys from
// build/<name>/keys, served by a stateProvider, plus a moduleProvider mapping its address to the
// generated module. contract-typed constructor args take { bytes: encodeContractAddress(addr) }.

/** A distinct, non-default 32-byte contract address (hex) for the simulator. */
export const simAddress = (n: number): string => n.toString(16).padStart(64, '0');
/** The value a contract-typed constructor argument / ledger field takes. */
export const contractRef = (addr: string) => ({ bytes: encodeContractAddress(addr) });

/** Ledger state `data` (ChargedState from a circuit result) wrapped as a deployed ContractState with real verifier keys. */
export function asDeployed(initial: ContractState, data: any, buildName: string): ContractState {
  const cs = new ContractState();
  cs.data = data ?? initial.data;
  const dir = new URL(`../build/${buildName}/keys/`, import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.verifier'))) {
    const op = new ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(new URL(f, dir)));
    cs.setOperation(f.replace(/\.verifier$/, ''), op);
  }
  return cs;
}

/** CircuitContextOptions.crossContract for callees { address: { state, module } }. */
export function crossContract(callees: Record<string, { state: ContractState; module: any }>) {
  return {
    stateProvider: { getContractState: async (_h: string, a: string) => callees[a]?.state },
    moduleProvider: { resolve: (a: string) => (callees[a] ? async () => callees[a].module : undefined) },
  };
}
export const SIM_BLOCK_HASH = '00'.repeat(32);
