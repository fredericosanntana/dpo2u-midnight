/**
 * PsavPassport issuance from the gateway queue (journey hook E3), pure part.
 *
 * Queue payload (JSON, one per passport), as the gateway enqueues it:
 *   { passportId, partnerCommit, packHash, packVersion, tier, issuedAt, expiresAt, verdict,
 *     ruleCounts: { machine, human, third_party }, evidenceCommit, reviewerCommit }
 *
 * Where each field goes in PsavPassport.issuePassport (QUEUE_FIELD_MAP):
 *   circuit arguments      passportId, packHash, packVersion, tier, issuedAt, expiresAt
 *   computed IN the circuit from private witnesses, so they cannot be passed in:
 *     partnerCommit   = labeled_commit(partner_id, commit_salt, "partner")
 *     evidenceCommit  = labeled_commit(evidence_hash, commit_salt, "evidence")
 *     reviewerCommit  = labeled_commit(reviewer_sig_hash, commit_salt, "reviewer"), zeros without reviewer
 *     ruleCounts      = counts of rule_origins (16 slots: origin 1 machine, 2 human, 3 third party)
 *     verdict         = rule over rule_origins / rule_verdicts / tier / reviewer (returned by the circuit)
 * So the operator also needs the PRIVATE preimages (mode-600 file, never in the queue):
 *   { partnerId, commitSalt, evidenceHash, reviewerSigHash | null, rules: [{ origin, verdict }] }
 * and the hook recomputes every derived field and refuses to submit unless all of them match the
 * payload: what lands on chain is exactly what the gateway enqueued.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const QUEUE_FIELDS = ['passportId', 'partnerCommit', 'packHash', 'packVersion', 'tier', 'issuedAt', 'expiresAt', 'verdict', 'ruleCounts', 'evidenceCommit', 'reviewerCommit'] as const;

export const QUEUE_FIELD_MAP: Record<(typeof QUEUE_FIELDS)[number], string> = {
  passportId: 'argument passport_id',
  packHash: 'argument pack_hash_',
  packVersion: 'argument pack_version_ (UTF-8, padded to 32 bytes)',
  tier: 'argument tier_ (0 machine-only, 1, 2, 3)',
  issuedAt: 'argument issued_at_ (unix seconds)',
  expiresAt: 'argument expires_at_ (must equal issuedAt + tier window: 365 days tier 0/1, 31 days tier 2/3)',
  partnerCommit: 'computed in-circuit: labeled_commit(partner_id, commit_salt, "partner"); checked against the private preimages',
  evidenceCommit: 'computed in-circuit: labeled_commit(evidence_hash, commit_salt, "evidence"); checked',
  reviewerCommit: 'computed in-circuit: labeled_commit(reviewer_sig_hash, commit_salt, "reviewer") or zeros; checked',
  ruleCounts: 'computed in-circuit from rule_origins (16 slots); checked',
  verdict: 'computed in-circuit (returned by issuePassport); checked before submit and against the result',
};

export type QueuePassport = {
  passportId: Uint8Array; partnerCommit: Uint8Array; packHash: Uint8Array; packVersion: Uint8Array; tier: number;
  issuedAt: number; expiresAt: number; verdict: 1 | 2 | 3; ruleCounts: { machine: number; human: number; third_party: number };
  evidenceCommit: Uint8Array; reviewerCommit: Uint8Array;
};
export type PassportPreimages = { partnerId: Uint8Array; commitSalt: Uint8Array; evidenceHash: Uint8Array; reviewerSigHash: Uint8Array; rules: { origin: number; verdict: number }[] };

const HEX32 = /^[0-9a-f]{64}$/;
const VERDICTS: Record<string, 1 | 2 | 3> = { PASS: 1, FAIL: 2, REVIEW: 3, 1: 1, 2: 2, 3: 3 };
const ZERO = new Uint8Array(32);
const hexBytes = (v: string) => new Uint8Array(Buffer.from(v, 'hex'));
const pad32 = (s: string) => { const b = Buffer.alloc(32); const src = Buffer.from(s, 'utf-8'); if (src.length > 32) throw new Error('packVersion longer than 32 bytes'); src.copy(b); return new Uint8Array(b); };
/** passportId: 32-byte hex, or a label padded like the gate CLI's ids. */
const idOf = (v: string) => (HEX32.test(v) ? hexBytes(v) : pad32(v));
export const windowSeconds = (tier: number) => (tier <= 1 ? 31_536_000 : 2_678_400);

/** Strict schema check of the queue payload: every field required, no defaults. */
export function parseQueuePayload(j: any): QueuePassport {
  const missing = QUEUE_FIELDS.filter((k) => j?.[k] === undefined || j?.[k] === null);
  if (missing.length) throw new Error(`queue payload missing: ${missing.join(', ')}`);
  const bad: string[] = [];
  for (const k of ['partnerCommit', 'packHash', 'evidenceCommit', 'reviewerCommit'] as const) if (!HEX32.test(String(j[k]))) bad.push(`${k} must be 32 bytes lowercase hex`);
  if (typeof j.passportId !== 'string' || !j.passportId) bad.push('passportId must be a non-empty string');
  if (typeof j.packVersion !== 'string' || !j.packVersion) bad.push('packVersion must be a non-empty string');
  if (!Number.isInteger(j.tier) || j.tier < 0 || j.tier > 3) bad.push('tier must be 0..3');
  if (!Number.isSafeInteger(j.issuedAt) || !Number.isSafeInteger(j.expiresAt)) bad.push('issuedAt / expiresAt must be unix seconds');
  else if (Number.isInteger(j.tier) && j.expiresAt !== j.issuedAt + windowSeconds(j.tier)) bad.push(`expiresAt must be issuedAt + ${windowSeconds(j.tier)} for tier ${j.tier}`);
  if (!(String(j.verdict).toUpperCase() in VERDICTS)) bad.push('verdict must be PASS, FAIL or REVIEW (or 1, 2, 3)');
  const rc = j.ruleCounts;
  if (!rc || !['machine', 'human', 'third_party'].every((k) => Number.isInteger(rc[k]) && rc[k] >= 0)) bad.push('ruleCounts must be { machine, human, third_party } non-negative integers');
  if (bad.length) throw new Error('queue payload invalid: ' + bad.join('; '));
  return {
    passportId: idOf(j.passportId), partnerCommit: hexBytes(j.partnerCommit), packHash: hexBytes(j.packHash), packVersion: pad32(j.packVersion),
    tier: j.tier, issuedAt: j.issuedAt, expiresAt: j.expiresAt, verdict: VERDICTS[String(j.verdict).toUpperCase()],
    ruleCounts: { machine: rc.machine, human: rc.human, third_party: rc.third_party },
    evidenceCommit: hexBytes(j.evidenceCommit), reviewerCommit: hexBytes(j.reviewerCommit),
  };
}

/** Private preimages from a mode-600 file. */
export function readPreimages(file: string): PassportPreimages {
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(`${file} holds passport preimages: it must be mode 600`);
  return parsePreimages(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export function parsePreimages(j: any): PassportPreimages {
  for (const k of ['partnerId', 'commitSalt', 'evidenceHash']) if (!HEX32.test(String(j?.[k]))) throw new Error(`preimages.${k} must be 32 bytes hex`);
  if (j.reviewerSigHash !== null && !HEX32.test(String(j.reviewerSigHash))) throw new Error('preimages.reviewerSigHash must be 32 bytes hex or null');
  if (!Array.isArray(j.rules) || j.rules.length === 0 || j.rules.length > 16) throw new Error('preimages.rules must list 1..16 rules');
  for (const r of j.rules) if (![1, 2, 3].includes(r?.origin) || ![1, 2, 3].includes(r?.verdict)) throw new Error('each rule needs origin 1|2|3 and verdict 1|2|3');
  return { partnerId: hexBytes(j.partnerId), commitSalt: hexBytes(j.commitSalt), evidenceHash: hexBytes(j.evidenceHash), reviewerSigHash: j.reviewerSigHash ? hexBytes(j.reviewerSigHash) : ZERO, rules: j.rules };
}

/** The verdict rule of PsavPassport.issuePassport, off-chain (kept equal by test against the circuit). */
export function expectedVerdict(tier: number, rules: { origin: number; verdict: number }[], hasReviewer: boolean): 1 | 2 | 3 {
  if (rules.some((r) => r.verdict === 2)) return 2;
  const machine = rules.filter((r) => r.origin === 1);
  const pass = tier === 0 ? machine.length > 0 && machine.every((r) => r.verdict === 1) : rules.every((r) => r.verdict === 1) && hasReviewer;
  return pass ? 1 : 3;
}

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const label = (s: string) => pad32(s);

/**
 * Arguments and witnesses for issuePassport from a queue payload plus the private preimages.
 * Refuses when any derived field differs from the payload.
 */
export function issueFromQueue(Passport: { pureCircuits: { labeled_commit(v: Uint8Array, s: Uint8Array, l: Uint8Array): Uint8Array } }, q: QueuePassport, p: PassportPreimages) {
  const lc = Passport.pureCircuits.labeled_commit;
  const hasReviewer = !eq(p.reviewerSigHash, ZERO);
  const problems: string[] = [];
  if (!eq(lc(p.partnerId, p.commitSalt, label('partner')), q.partnerCommit)) problems.push('partnerCommit does not match labeled_commit(partnerId, commitSalt, "partner")');
  if (!eq(lc(p.evidenceHash, p.commitSalt, label('evidence')), q.evidenceCommit)) problems.push('evidenceCommit does not match labeled_commit(evidenceHash, commitSalt, "evidence")');
  const rev = hasReviewer ? lc(p.reviewerSigHash, p.commitSalt, label('reviewer')) : ZERO;
  if (!eq(rev, q.reviewerCommit)) problems.push('reviewerCommit does not match the reviewer preimage (zeros when there is no reviewer)');
  const counts = { machine: p.rules.filter((r) => r.origin === 1).length, human: p.rules.filter((r) => r.origin === 2).length, third_party: p.rules.filter((r) => r.origin === 3).length };
  if (counts.machine !== q.ruleCounts.machine || counts.human !== q.ruleCounts.human || counts.third_party !== q.ruleCounts.third_party) problems.push(`ruleCounts ${JSON.stringify(q.ruleCounts)} do not match the rules ${JSON.stringify(counts)}`);
  if (p.rules.some((r) => r.origin >= 2 && r.verdict === 1) && !hasReviewer) problems.push('a PASS on a human/third-party rule needs the reviewer signature (the circuit would refuse)');
  const v = expectedVerdict(q.tier, p.rules, hasReviewer);
  if (v !== q.verdict) problems.push(`verdict ${q.verdict} does not match the rules (${v})`);
  if (problems.length) throw new Error('queue payload does not match its preimages: ' + problems.join('; '));
  const slots = [...p.rules, ...Array(16 - p.rules.length).fill({ origin: 0, verdict: 0 })];
  return {
    args: [q.passportId, q.packHash, q.packVersion, BigInt(q.tier), BigInt(q.issuedAt), BigInt(q.expiresAt)] as const,
    witnesses: {
      rule_origins: slots.map((r) => BigInt(r.origin)), rule_verdicts: slots.map((r) => BigInt(r.verdict)),
      partner_id: p.partnerId, commit_salt: p.commitSalt, reviewer_sig_hash: p.reviewerSigHash, evidence_hash: p.evidenceHash,
    },
    expectedVerdict: v,
  };
}

/** sha256 of the payload file contents, for the operator's record of what was issued from the queue. */
export const payloadDigest = (raw: string) => createHash('sha256').update(raw).digest('hex');
