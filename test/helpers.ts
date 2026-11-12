/**
 * Shared simulator setup for the access-controlled contracts.
 *
 * Every contract takes owner_commit in its constructor and reads owner_secret from a witness.
 * The private state is { ownerSecret }, so a test can switch caller with asStranger(ctx).
 * Runtime-specific calls (compact-runtime 0.21 / compactc 0.36) live only in this file.
 */
import { createCircuitContext, createConstructorContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';

export type OwnerPS = { ownerSecret: Uint8Array };

export const b32 = (s: string): Uint8Array => {
  const x = Buffer.alloc(32);
  Buffer.from(s, 'utf-8').copy(x, 0, 0, Math.min(Buffer.byteLength(s), 32));
  return new Uint8Array(x);
};

export const OWNER_SECRET = b32('dpo2u-owner-secret-test-only');
export const STRANGER_SECRET = b32('someone-else-entirely');
export const NOT_OWNER = /Only the contract owner can do this/;

const witnesses = {
  owner_secret: (c: any) => [c.privateState, (c.privateState as OwnerPS).ownerSecret] as [OwnerPS, Uint8Array],
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
