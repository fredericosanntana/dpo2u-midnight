/**
 * Owner key for the access-controlled DPO2U contracts.
 *
 * Every contract in compact/ gates its state-changing circuits with
 *   assert(owner_commitment(owner_secret()) == owner_commit)
 * where owner_secret is a private witness and owner_commit is fixed at deploy time.
 * owner_commitment is domain-tagged per contract (persistentHash of ["dpo2u/owner/v1", <contract
 * name>, secret]), so one secret gives a different owner_commit in each contract. Always compute it
 * with the contract's own pure circuit (ownerCommit below), never with a generic hash.
 *
 * Secret source, in order:
 *   1. DPO2U_OWNER_SECRET: 32-byte hex, kept apart from the wallet seed. REQUIRED on mainnet.
 *   2. Testnets only: derived from the wallet seed, sha256("dpo2u/owner/v1" || seed).
 * The secret is never printed or written to disk.
 * Also: the ComplianceRegistry score salt and the TravelRuleGate disclosure approver key (below).
 */
import { createHash } from 'node:crypto';

/** network defaults to MIDNIGHT_NETWORK (the same default as networkConfig). Mainnet never derives from the seed. */
export function ownerSecret(seedHex?: string, network: string = process.env.MIDNIGHT_NETWORK ?? 'preview'): Uint8Array {
  const explicit = (process.env.DPO2U_OWNER_SECRET ?? '').trim();
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error('DPO2U_OWNER_SECRET must be 32 bytes of hex');
    return new Uint8Array(Buffer.from(explicit, 'hex'));
  }
  if (network === 'mainnet') throw new Error('Mainnet needs DPO2U_OWNER_SECRET (32 bytes of hex, kept apart from the wallet seed): the owner secret is never derived from the seed on mainnet');
  const seed = (seedHex ?? process.env.MIDNIGHT_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]+$/.test(seed)) throw new Error('Set DPO2U_OWNER_SECRET or MIDNIGHT_SEED to derive the contract owner secret');
  return new Uint8Array(createHash('sha256').update('dpo2u/owner/v1').update(Buffer.from(seed, 'hex')).digest());
}

// ── ComplianceRegistry score salt ──
// attestCompliance stores persistentCommit(score, score_salt). The salt is derived, not stored:
//   sha256("dpo2u/score-salt/v1" || owner_secret || context)
// so the owner can always re-derive it to open the commitment for the company or an auditor, and
// it differs per attestation (context is anti-replay, so unique). Never printed.
export function scoreSalt(secret: Uint8Array, context: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update('dpo2u/score-salt/v1').update(secret).update(context).digest());
}

let pendingScoreSalt: Uint8Array | undefined;
/** Sets the salt the score_salt witness answers on the next attestCompliance. */
export function setScoreSalt(salt: Uint8Array | undefined): void { pendingScoreSalt = salt; }

/**
 * Witnesses object for CompiledContract.withWitnesses: owner_secret for every owner-only circuit,
 * plus score_salt (declared only by ComplianceRegistry; other contracts ignore it). score_salt
 * refuses unless setScoreSalt ran first, so no attestation is sealed with a forgotten salt.
 */
export function ownerWitnesses(secret: Uint8Array) {
  return {
    owner_secret: (ctx: any) => [ctx.privateState, secret] as const,
    score_salt: (ctx: any) => {
      if (!pendingScoreSalt) throw new Error('score_salt not set: call setScoreSalt(scoreSalt(secret, context)) before attestCompliance');
      return [ctx.privateState, pendingScoreSalt] as const;
    },
  };
}

// ── TravelRuleGate disclosure approver (second key) ──
// approver_commit = TravelRuleGate.approver_commitment(approver_secret). The approver (e.g. the DPO)
// holds a key apart from the owner's. For deploy only the commitment is needed:
//   1. DPO2U_APPROVER_COMMIT: 32-byte hex commitment (the approver never hands over the secret).
//   2. DPO2U_APPROVER_SECRET: 32-byte hex secret; the commitment is computed here.
//   3. Testnets only: derived from the wallet seed with its own label. Mainnet refuses this.
// Refuses a secret equal to the owner secret.
export function approverCommit(contractModule: any, network: string, ownerSecretBytes: Uint8Array, seedHex?: string): Uint8Array {
  const commit = (process.env.DPO2U_APPROVER_COMMIT ?? '').trim();
  if (commit) {
    if (!/^[0-9a-fA-F]{64}$/.test(commit)) throw new Error('DPO2U_APPROVER_COMMIT must be 32 bytes of hex');
    return new Uint8Array(Buffer.from(commit, 'hex'));
  }
  const f = contractModule?.pureCircuits?.approver_commitment;
  if (typeof f !== 'function') throw new Error('Contract has no approver_commitment pure circuit; recompile with compact/ from this branch');
  return f(approverSecret(network, ownerSecretBytes, seedHex));
}

export function approverSecret(network: string, ownerSecretBytes: Uint8Array, seedHex?: string): Uint8Array {
  const explicit = (process.env.DPO2U_APPROVER_SECRET ?? '').trim();
  let s: Uint8Array;
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error('DPO2U_APPROVER_SECRET must be 32 bytes of hex');
    s = new Uint8Array(Buffer.from(explicit, 'hex'));
  } else {
    if (network === 'mainnet') throw new Error('Mainnet needs DPO2U_APPROVER_COMMIT or DPO2U_APPROVER_SECRET (a key apart from DPO2U_OWNER_SECRET)');
    const seed = (seedHex ?? process.env.MIDNIGHT_SEED ?? '').trim();
    if (!/^[0-9a-fA-F]+$/.test(seed)) throw new Error('Set DPO2U_APPROVER_SECRET or MIDNIGHT_SEED to derive the disclosure approver secret');
    s = new Uint8Array(createHash('sha256').update('dpo2u/approver/v1').update(Buffer.from(seed, 'hex')).digest());
  }
  if (Buffer.from(s).equals(Buffer.from(ownerSecretBytes))) throw new Error('DPO2U_APPROVER_SECRET must differ from the owner secret');
  return s;
}

/** Witnesses for the approver's session on TravelRuleGate (approveDisclosure). */
export function approverWitnesses(secret: Uint8Array) {
  return { approver_secret: (ctx: any) => [ctx.privateState, secret] as const };
}

/** owner_commit for the constructor, computed with the contract's own pure circuit. */
export function ownerCommit(contractModule: any, secret: Uint8Array): Uint8Array {
  const f = contractModule?.pureCircuits?.owner_commitment;
  if (typeof f !== 'function') throw new Error('Contract has no owner_commitment pure circuit; recompile with compact/ from this branch');
  return f(secret);
}
