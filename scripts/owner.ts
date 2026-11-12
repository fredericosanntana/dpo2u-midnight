/**
 * Owner key for the access-controlled DPO2U contracts.
 *
 * Every contract in compact/ gates its state-changing circuits with
 *   assert(persistentHash(owner_secret()) == owner_commit)
 * where owner_secret is a private witness and owner_commit is fixed at deploy time.
 *
 * Secret source, in order:
 *   1. DPO2U_OWNER_SECRET: 32-byte hex. Use this on mainnet, kept apart from the wallet seed.
 *   2. Derived from the wallet seed: sha256("dpo2u/owner/v1" || seed). Fine for testnets.
 * The secret is never printed or written to disk.
 */
import { createHash } from 'node:crypto';

export function ownerSecret(seedHex?: string): Uint8Array {
  const explicit = (process.env.DPO2U_OWNER_SECRET ?? '').trim();
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error('DPO2U_OWNER_SECRET must be 32 bytes of hex');
    return new Uint8Array(Buffer.from(explicit, 'hex'));
  }
  const seed = (seedHex ?? process.env.MIDNIGHT_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]+$/.test(seed)) throw new Error('Set DPO2U_OWNER_SECRET or MIDNIGHT_SEED to derive the contract owner secret');
  return new Uint8Array(createHash('sha256').update('dpo2u/owner/v1').update(Buffer.from(seed, 'hex')).digest());
}

/** Witnesses object for CompiledContract.withWitnesses: supplies owner_secret to every owner-only circuit. */
export function ownerWitnesses(secret: Uint8Array) {
  return {
    owner_secret: (ctx: any) => [ctx.privateState, secret] as const,
  };
}

/** owner_commit for the constructor, computed with the contract's own pure circuit. */
export function ownerCommit(contractModule: any, secret: Uint8Array): Uint8Array {
  const f = contractModule?.pureCircuits?.owner_commitment;
  if (typeof f !== 'function') throw new Error('Contract has no owner_commitment pure circuit; recompile with compact/ from this branch');
  return f(secret);
}
