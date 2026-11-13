/**
 * One TravelRuleGate per institution (journey hook E6), pure part.
 *
 * The shared PsavPassport and ComplianceRegistry stay under `contracts`; each institution gets its
 * own gate, recorded in deployment-<network>-v9.json as
 *   institutions.<id>.TravelRuleGate = { contractAddress, ..., codeVersion, links, institution,
 *                                        selfCompanyId, approverCommit, thresholdCents }
 * The approver key is the INSTITUTION's: only its commitment is given (--approver-commit or
 * DPO2U_APPROVER_COMMIT), never a secret and never derived from the operator's seed.
 */
export const INSTITUTION_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

export function checkInstitutionId(id: string): string {
  if (!INSTITUTION_ID.test(id)) throw new Error('institution id must be 2-63 chars of a-z, 0-9 and "-" (no client names with spaces or accents; use the gateway clientId)');
  return id;
}

export type InstitutionGateInput = { institution: string; selfCompanyId?: string; approverCommit?: string; thresholdCents?: string };

/** Validated constructor inputs (after owner_commit) for an institution's gate. */
export function institutionGateInputs(i: InstitutionGateInput, env: Record<string, string | undefined> = process.env) {
  checkInstitutionId(i.institution);
  const approver = (i.approverCommit ?? env.DPO2U_APPROVER_COMMIT ?? '').trim();
  if (!HEX64.test(approver)) throw new Error(`institution ${i.institution}: the approver commitment is required (--approver-commit or DPO2U_APPROVER_COMMIT, 32 bytes hex) — the institution's own key, never derived here`);
  const self = (i.selfCompanyId ?? env.TRAVEL_RULE_SELF_COMPANY_ID ?? '').trim();
  if (!self) throw new Error(`institution ${i.institution}: --self-company-id is required (company_id it is attested under in the ComplianceRegistry)`);
  const threshold = BigInt(i.thresholdCents ?? env.TRAVEL_RULE_THRESHOLD_CENTS ?? '100000');
  if (threshold <= 0n) throw new Error('threshold must be > 0 cents');
  return { approverCommit: new Uint8Array(Buffer.from(approver, 'hex')), selfCompanyId: self, thresholdCents: threshold };
}

/** The institution's gate entry from a deployment file object, or undefined. */
export const institutionGate = (deployment: any, id: string) => deployment?.institutions?.[checkInstitutionId(id)]?.TravelRuleGate;

/** Writes the gate entry under institutions.<id> (mutates and returns the deployment object). */
export function recordInstitutionGate(deployment: any, id: string, entry: Record<string, unknown>) {
  checkInstitutionId(id);
  deployment.institutions ??= {};
  deployment.institutions[id] = { ...(deployment.institutions[id] ?? {}), TravelRuleGate: entry };
  return deployment;
}
