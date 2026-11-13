/**
 * Cross-contract calls in the Compact simulator (compactc 0.36 / compact-runtime 0.21), no network.
 *
 * A callee must look deployed: a ContractState whose operations carry the verifier keys from
 * build/<name>/keys, served by a stateProvider, plus a moduleProvider mapping its address to the
 * generated module. Contract-typed constructor args / ledger fields take
 * { bytes: encodeContractAddress(addr) }. Used by test/ and scripts/demo-travel-rule.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractOperation, ContractState, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

/** A distinct, non-default 32-byte contract address (hex) for the simulator. */
export const simAddress = (n: number): string => n.toString(16).padStart(64, '0');
/** The value a contract-typed constructor argument / ledger field takes. */
export const contractRef = (addr: string) => ({ bytes: encodeContractAddress(addr) });
/** Any fixed block hash: callee states are pinned to it. */
export const SIM_BLOCK_HASH = '00'.repeat(32);

/** Ledger state `data` (ChargedState from a circuit result) wrapped as a deployed ContractState with real verifier keys. */
export function asDeployed(initial: ContractState, data: any, buildName: string): ContractState {
  const cs = new ContractState();
  cs.data = data ?? initial.data;
  const dir = path.join(BUILD, buildName, 'keys');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.verifier'))) {
    const op = new ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(path.join(dir, f)));
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
