/**
 * Jurisdiction-code parity for Midnight — dual-chain alignment with Stellar/Solana.
 *
 * The DPO2U compliance engine covers a fixed set of jurisdiction frameworks. On Midnight
 * there is NO per-jurisdiction circuit: the single `ComplianceRegistry.attestUseCase`
 * circuit seals a verdict for ANY use case, keyed by a deterministic `use_case_id`. This
 * module is the canonical mapping from a jurisdiction code to that 32-byte id, so every
 * code routes through the one audited contract — the same evidence/verdict model used by
 * the Stellar `anticorruption-attestation` and Solana `compliance-registry`.
 *
 * SOURCE OF TRUTH: this list mirrors `JURISDICTION_CODES` in the DPO2U MCP server
 * (packages/mcp-server/src/kb/jurisdictions/index.ts). Keep them in sync — the MCP server
 * is the upstream authority; this file is the on-chain projection of it.
 */
import { createHash } from 'node:crypto';

export const JURISDICTION_CODES = [
  'LGPD', 'GDPR', 'DPDP', 'MICAR', 'MICAR-CASP', 'PDPA', 'UAE', 'POPIA', 'NDPA',
  'CCPA', 'PIPEDA', 'LAW25', 'PIPA', 'PDP', 'APPI', 'MEXICO', 'VIETNAM', 'MALAYSIA',
  'KENYA', 'GHANA', 'COLOMBIA', 'TANZANIA', 'RWANDA', 'UGANDA', 'ARGENTINA',
] as const;

export type JurisdictionCode = (typeof JURISDICTION_CODES)[number];

/**
 * Deterministic 32-byte `use_case_id` for a jurisdiction compliance predicate (version vN).
 * SHA-256 over a domain-separated, canonical string → exactly Bytes<32> for the contract.
 * Stable across runs and chains, so an off-chain verifier can recompute the id for any code.
 */
export function useCaseId(code: JurisdictionCode, version = 1): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update(`dpo2u:${code}:compliance:v${version}`).digest(),
  );
}

/** SHA-256 of an arbitrary string → Bytes<32> (evidence/metadata hashes for attestUseCase). */
export function sha256Bytes32(input: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}
