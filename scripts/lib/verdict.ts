/**
 * Common Travel Rule verdict format, version 1 (docs/VERDICT-FORMAT.md). One object per transfer,
 * the same on every chain a verdict is read from or mirrored to. Built here from the TravelRuleGate
 * public ledger (Midnight); readers on other chains consume the same shape and digest.
 */
import { createHash } from 'node:crypto';

export const VERDICT_FORMAT = 'dpo2u.travel-rule-verdict/1';

export const REASON_LABELS: Record<number, string> = {
  0: 'none',
  1: 'missing_party_info',
  2: 'missing_originator_document_above_threshold',
  3: 'counterparty_vasp_not_attested',
  4: 'sanctions_hit',
};

export type Verdict = {
  format: typeof VERDICT_FORMAT;
  transfer_id: string;                 // hex32
  verdict: 'PASS' | 'FAIL';
  released: boolean;                   // PASS and released on chain (status 3)
  reason: { code: number; label: string };
  policy_hash: string;                 // hex32
  originator_root: string;             // hex32
  beneficiary_root: string;            // hex32
  source_chain: string;                // e.g. "midnight:preview", "midnight:mainnet", "midnight:simulator"
  source_contract: string;             // hex contract address
  block: { height: number; hash: string } | null;   // block of the anchoring tx, null when not anchored
  tx: string | null;                   // tx id of the anchoring tx (evaluateTransfer or releaseTransfer)
  sanctions?: { list_root: string; provider_id: string; valid_until: number };  // when the gate records signed lists
};

const HEX32 = /^[0-9a-f]{64}$/;
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** Verdict of one transfer from the gate ledger (Gate.ledger(state)). Refuses unknown transfers. */
export function verdictFromLedger(L: any, transferId: Uint8Array, meta: { source_chain: string; source_contract: string; block?: { height: number; hash: string } | null; tx?: string | null }): Verdict {
  if (!L.status.member(transferId)) throw new Error(`transfer ${hex(transferId)} has no verdict on this gate`);
  const status = Number(L.status.lookup(transferId));
  const code = Number(L.fail_reason.lookup(transferId));
  const v: Verdict = {
    format: VERDICT_FORMAT,
    transfer_id: hex(transferId),
    verdict: status === 2 ? 'FAIL' : 'PASS',
    released: status === 3,
    reason: { code, label: REASON_LABELS[code] ?? `unknown_${code}` },
    policy_hash: L.verdict_policy?.member?.(transferId) ? hex(L.verdict_policy.lookup(transferId)) : '0'.repeat(64),
    originator_root: hex(L.originator_root.lookup(transferId)),
    beneficiary_root: hex(L.beneficiary_root.lookup(transferId)),
    source_chain: meta.source_chain,
    source_contract: meta.source_contract.toLowerCase(),
    block: meta.block ?? null,
    tx: meta.tx ?? null,
  };
  if (L.verdict_sanctions_root?.member?.(transferId)) {
    v.sanctions = { list_root: hex(L.verdict_sanctions_root.lookup(transferId)), provider_id: hex(L.verdict_sanctions_provider.lookup(transferId)), valid_until: Number(L.verdict_sanctions_valid_until.lookup(transferId)) };
  }
  return v;
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson((v as any)[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** sha256 of the canonical JSON: what a reader on another chain stores or compares. */
export const verdictDigest = (v: Verdict) => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** Schema check for a verdict object; returns the problems (empty = valid). */
export function checkVerdict(v: any): string[] {
  const e: string[] = [];
  if (v?.format !== VERDICT_FORMAT) e.push(`format must be ${VERDICT_FORMAT}`);
  for (const k of ['transfer_id', 'policy_hash', 'originator_root', 'beneficiary_root']) if (!HEX32.test(String(v?.[k]))) e.push(`${k} must be 32 bytes lowercase hex`);
  if (!['PASS', 'FAIL'].includes(v?.verdict)) e.push('verdict must be PASS or FAIL');
  if (typeof v?.released !== 'boolean') e.push('released must be a boolean');
  if (v?.released && v?.verdict !== 'PASS') e.push('only a PASS can be released');
  if (!Number.isInteger(v?.reason?.code) || REASON_LABELS[v.reason.code] !== v?.reason?.label) e.push('reason must be { code 0..4, label } with the matching label');
  if ((v?.verdict === 'PASS') !== (v?.reason?.code === 0)) e.push('PASS has reason 0 and FAIL a non-zero reason');
  if (typeof v?.source_chain !== 'string' || !/^[a-z0-9-]+:[a-z0-9-]+$/.test(v.source_chain)) e.push('source_chain must be "<chain>:<network>"');
  if (!/^[0-9a-f]+$/.test(String(v?.source_contract))) e.push('source_contract must be hex');
  if (v?.block !== null && !(Number.isInteger(v?.block?.height) && /^[0-9a-f]+$/.test(String(v?.block?.hash)))) e.push('block must be null or { height, hash }');
  if (v?.tx !== null && !/^[0-9a-f]+$/.test(String(v?.tx))) e.push('tx must be null or hex');
  if ((v?.block === null) !== (v?.tx === null)) e.push('block and tx are both set or both null');
  if (v?.sanctions !== undefined && !(HEX32.test(String(v.sanctions.list_root)) && HEX32.test(String(v.sanctions.provider_id)) && Number.isInteger(v.sanctions.valid_until))) e.push('sanctions must be { list_root, provider_id, valid_until }');
  return e;
}
