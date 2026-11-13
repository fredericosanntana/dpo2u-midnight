/**
 * Role views over the Travel Rule gate's records. Each role gets an allow-listed projection; a
 * view never carries a field outside its list (enforced by construction and by test).
 *
 *   regulator   supervisor with a disclosure grant: opens the fields in the grant scope, through
 *               DisclosureGovernance.access (credential + on-chain grant approved). Not a bulk view.
 *   auditor     the whole public record (every transfer: status, reason, roots, policy hash) and the
 *               evidence pack; never openings of party fields.
 *   compliance  only transfers that FAILED the rule: reason code, roots, policy hash. No PASS/RELEASED
 *               transfer, no totals.
 *   risk        only aggregates: total pass / fail / released, per period. No transfer id, no root.
 *
 * Input is a GateSnapshot: what the public ledger holds per transfer (status, fail_reason, roots,
 * verdict_policy) plus the time the VASP recorded the evaluation (off-chain, for periods).
 */
export type Role = 'regulator' | 'auditor' | 'compliance' | 'risk';

export const REASONS: Record<number, string> = {
  0: 'none',
  1: 'missing required party info',
  2: 'missing originator document above threshold',
  3: 'counterparty VASP not attested and no valid PsavPassport',
  4: 'sanctions screening hit (VASP-attested)',
};

export type TransferRecord = {
  transfer_id: string;          // hex
  status: 1 | 2 | 3;            // 1 PASS, 2 FAIL, 3 RELEASED (on-chain status)
  fail_reason: number;          // on-chain reason code
  originator_root: string;      // hex
  beneficiary_root: string;     // hex
  policy_hash: string;          // hex, verdict_policy
  evaluated_at: number;         // unix seconds, off-chain record of the evaluation time
};
export type GateSnapshot = { gate: string; network: string; transfers: TransferRecord[] };

export const ROLE_DEFS: Record<Role, { sees: string[]; never: string[]; how: string }> = {
  regulator: {
    sees: ['party fields inside an approved, unexpired, unrevoked grant scope (name/account/document/vasp per party)'],
    never: ['fields outside the grant scope', 'transfers outside the grant', 'anything after expiry or revocation'],
    how: 'DisclosureGovernance.access with a credential; on chain the grant must be approved by the second key (TravelRuleGate.approveDisclosure)',
  },
  auditor: {
    sees: ['transfer_id', 'status', 'fail_reason', 'reason', 'originator_root', 'beneficiary_root', 'policy_hash', 'evaluated_at', 'evidence pack', 'disclosure log'],
    never: ['party field openings', 'salts', 'amounts'],
    how: "view('auditor', snapshot)",
  },
  compliance: {
    sees: ['transfer_id (FAIL only)', 'fail_reason', 'reason', 'originator_root', 'beneficiary_root', 'policy_hash', 'evaluated_at'],
    never: ['PASS or RELEASED transfers', 'totals', 'party field openings', 'salts', 'amounts'],
    how: "view('compliance', snapshot)",
  },
  risk: {
    sees: ['per period: total pass, total fail, total released, fail count per reason code'],
    never: ['transfer ids', 'roots', 'policy hashes', 'party data'],
    how: "view('risk', snapshot, { period: 'day' | 'month' })",
  },
};

export type Period = 'day' | 'month';
const bucket = (ts: number, p: Period) => new Date(ts * 1000).toISOString().slice(0, p === 'day' ? 10 : 7);

const COMPLIANCE_FIELDS = ['transfer_id', 'fail_reason', 'reason', 'originator_root', 'beneficiary_root', 'policy_hash', 'evaluated_at'] as const;
const AUDITOR_FIELDS = ['transfer_id', 'status', 'fail_reason', 'reason', 'originator_root', 'beneficiary_root', 'policy_hash', 'evaluated_at'] as const;
const pick = (r: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, r[k]]));

export function view(role: Role, s: GateSnapshot, opts: { period?: Period } = {}): Record<string, unknown> {
  const withReason = s.transfers.map((t) => ({ ...t, reason: REASONS[t.fail_reason] ?? `unknown(${t.fail_reason})` }));
  switch (role) {
    case 'compliance':
      return { role, gate: s.gate, network: s.network, failed: withReason.filter((t) => t.status === 2).map((t) => pick(t, COMPLIANCE_FIELDS)) };
    case 'auditor':
      return { role, gate: s.gate, network: s.network, transfers: withReason.map((t) => pick(t, AUDITOR_FIELDS)) };
    case 'risk': {
      const period = opts.period ?? 'month';
      const by = new Map<string, { period: string; pass: number; fail: number; released: number; fail_by_reason: Record<string, number> }>();
      for (const t of s.transfers) {
        const k = bucket(t.evaluated_at, period);
        const b = by.get(k) ?? { period: k, pass: 0, fail: 0, released: 0, fail_by_reason: {} };
        // RELEASED transfers passed first: they count in pass and in released.
        if (t.status === 1 || t.status === 3) b.pass++;
        if (t.status === 3) b.released++;
        if (t.status === 2) { b.fail++; b.fail_by_reason[String(t.fail_reason)] = (b.fail_by_reason[String(t.fail_reason)] ?? 0) + 1; }
        by.set(k, b);
      }
      return { role, gate: s.gate, network: s.network, period, buckets: [...by.values()].sort((a, b) => a.period.localeCompare(b.period)) };
    }
    case 'regulator':
      throw new Error('regulator has no bulk view: it reads through a disclosure grant (DisclosureGovernance.access)');
  }
}

/** Validates a snapshot file (hex fields, status/reason ranges) before any view is built. */
export function parseSnapshot(j: any): GateSnapshot {
  const HEX = /^[0-9a-f]{64}$/;
  if (!j || !Array.isArray(j.transfers)) throw new Error('snapshot needs transfers[]');
  for (const [i, t] of j.transfers.entries()) {
    for (const k of ['transfer_id', 'originator_root', 'beneficiary_root', 'policy_hash']) if (!HEX.test(String(t[k]))) throw new Error(`transfers[${i}].${k} must be 32 bytes hex`);
    if (![1, 2, 3].includes(t.status)) throw new Error(`transfers[${i}].status must be 1, 2 or 3`);
    if (!Number.isInteger(t.fail_reason) || t.fail_reason < 0 || t.fail_reason > 4) throw new Error(`transfers[${i}].fail_reason must be 0..4`);
    if (!Number.isInteger(t.evaluated_at)) throw new Error(`transfers[${i}].evaluated_at must be unix seconds`);
  }
  return { gate: String(j.gate ?? ''), network: String(j.network ?? ''), transfers: j.transfers };
}
