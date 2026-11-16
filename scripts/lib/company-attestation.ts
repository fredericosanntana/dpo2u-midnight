/**
 * Journey E4: the institution's self-attestation after its first passport, queued by the gateway as
 * kind "company_attestation" and sealed by the agent on ComplianceRegistry.attestCompliance with
 * company_id as the key (TravelRuleGate.releaseTransfer checks registry.hasAttestation(self_company_id)).
 *
 * Queue item (pure part, no network):
 *   company_id     sha256 hex of the gateway clientId (32 bytes): the registry key, used as is
 *   evidence_hash  sha256 hex of the evaluation report behind the verdict (recorded on chain)
 *   verdict        PASS only: a FAIL is not attested (the circuit needs score >= threshold)
 *   score          0..100, PRIVATE: proven >= threshold, kept off the ledger (score_commit only)
 *   threshold      0..100, public
 *   passport_ref   the passport that triggered E4 (also the replay nonce: one attestation per passport)
 *   regimes[]      regime codes evaluated, engine: evaluator id/version
 *
 * policy_cid (on chain) = sha256 of the canonical JSON { engine, passport_ref, regimes (sorted) }, so
 * the regimes and engine behind the attestation are checkable without being written in clear.
 * context = sha256(company_id || "self-attestation" || passport_ref): the registry refuses a reused
 * context, so the same passport cannot be self-attested twice.
 */
import { createHash } from 'node:crypto';
import { companyIdBytes } from './institutions.js';

export type CompanyAttestation = {
  companyId: Uint8Array; evidenceHash: Uint8Array; score: bigint; threshold: bigint;
  policyCid: Uint8Array; context: Uint8Array; passportRef: string; regimes: string[]; engine: string;
};

const HEX32 = /^[0-9a-f]{64}$/;
const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

export function policyCid(engine: string, passportRef: string, regimes: string[]): Uint8Array {
  return sha(JSON.stringify({ engine, passport_ref: passportRef, regimes: [...regimes].sort() }));
}
export function selfAttestationContext(companyIdHex: string, passportRef: string): Uint8Array {
  return sha(`${companyIdHex}||self-attestation||${passportRef}`);
}

/** Strict check of a queued company_attestation; no defaults for anything that reaches the chain. */
export function parseCompanyAttestation(j: any): CompanyAttestation {
  const bad: string[] = [];
  const cid = String(j?.company_id ?? '').toLowerCase(), ev = String(j?.evidence_hash ?? '').toLowerCase();
  if (!HEX32.test(cid)) bad.push('company_id must be 32 bytes hex (sha256 of the clientId)');
  if (!HEX32.test(ev)) bad.push('evidence_hash must be 32 bytes hex');
  if (String(j?.verdict).toUpperCase() !== 'PASS' && j?.verdict !== 1) bad.push('verdict must be PASS (a FAIL is not attested)');
  for (const k of ['score', 'threshold']) if (!Number.isInteger(j?.[k]) || j[k] < 0 || j[k] > 100) bad.push(`${k} must be an integer 0..100`);
  if (Number.isInteger(j?.score) && Number.isInteger(j?.threshold) && j.score < j.threshold) bad.push('score is below threshold: nothing to attest');
  if (typeof j?.passport_ref !== 'string' || !j.passport_ref) bad.push('passport_ref must be a non-empty string');
  if (!Array.isArray(j?.regimes) || j.regimes.length === 0 || !j.regimes.every((r: unknown) => typeof r === 'string' && r)) bad.push('regimes must be a non-empty list of codes');
  if (typeof j?.engine !== 'string' || !j.engine) bad.push('engine must be a non-empty string');
  if (bad.length) throw new Error('company_attestation invalid: ' + bad.join('; '));
  return {
    companyId: companyIdBytes(cid), evidenceHash: bytes(ev), score: BigInt(j.score), threshold: BigInt(j.threshold),
    policyCid: policyCid(j.engine, j.passport_ref, j.regimes), context: selfAttestationContext(cid, j.passport_ref),
    passportRef: j.passport_ref, regimes: [...j.regimes], engine: j.engine,
  };
}
