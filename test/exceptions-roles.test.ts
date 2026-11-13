/**
 * Exception queue and role views (src/disclosure/exceptions.ts, roles.ts) on the hash-chained
 * disclosure log: every FAIL becomes one item with owner/due/decision/justification; compliance
 * sees only FAILs; risk sees only aggregates; everything is logged and survives a reload.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DisclosureGovernance } from '../src/disclosure/governance.js';
import { failsOf, exceptionId } from '../src/disclosure/exceptions.js';
import { view, parseSnapshot, type GateSnapshot } from '../src/disclosure/roles.js';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 86_400, T0 = 1_800_000_000; // 2027-01-15
const tr = (n: string, status: 1 | 2 | 3, reason: number, at = T0) => ({ transfer_id: h('t' + n), status, fail_reason: reason, originator_root: h('o' + n), beneficiary_root: h('b' + n), policy_hash: h('policy:v1'), evaluated_at: at });
const SNAP: GateSnapshot = { gate: 'aa'.repeat(32), network: 'preview', transfers: [tr('1', 3, 0), tr('2', 2, 3), tr('3', 2, 4, T0 + DAY), tr('4', 1, 0, T0 + 40 * DAY), tr('5', 2, 1, T0 + 40 * DAY)] };

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exc-'));
  const clock = { t: T0 };
  const key = randomBytes(32);
  const logPath = path.join(dir, 'log.jsonl');
  return { clock, key, logPath, gov: new DisclosureGovernance(key, logPath, () => clock.t) };
}

describe('exception queue', () => {
  it('every FAIL opens exactly one item with owner, reason and a due date by reason code', () => {
    const { gov } = mk();
    const items = failsOf(SNAP.transfers).map((f) => gov.openException({ ...f, owner: 'compliance' }));
    assert.equal(items.length, 3);
    const sanctions = items.find((i) => i.reason_code === 4)!;
    assert.equal(sanctions.due_at - sanctions.opened_at, 24 * 3600);
    assert.match(sanctions.reason, /sanctions/);
    assert.equal(items.find((i) => i.reason_code === 3)!.due_at - T0, 48 * 3600);
    assert.equal(items[0].policy_hash, h('policy:v1'));
    // idempotent: re-ingesting the same snapshot opens nothing new
    failsOf(SNAP.transfers).forEach((f) => gov.openException({ ...f, owner: 'someone-else' }));
    assert.equal(gov.exceptions().length, 3);
    assert.equal(gov.exceptions()[0].owner, 'compliance');
  });

  it('refused attestations are items too', () => {
    const { gov } = mk();
    const it1 = gov.openException({ source: 'attestation_refused', ref: 'ctx:acme||LGPD||nonce-7', reason_code: 0, reason_text: 'Score below threshold', owner: 'dpo' });
    assert.equal(it1.reason, 'Score below threshold');
    assert.equal(it1.due_at - it1.opened_at, 72 * 3600);
    assert.equal(it1.id, exceptionId('attestation_refused', 'ctx:acme||LGPD||nonce-7'));
  });

  it('decision needs a known decision, who decided and a real justification; decided once', () => {
    const { gov } = mk();
    const [a] = failsOf(SNAP.transfers).map((f) => gov.openException({ ...f, owner: 'compliance' }));
    assert.throws(() => gov.decideException(a.id, { decision: 'ok', by: 'cco', justification: 'x'.repeat(30) }), /decision must be one of/);
    assert.throws(() => gov.decideException(a.id, { decision: 'uphold', by: '', justification: 'x'.repeat(30) }), /decided_by/);
    assert.throws(() => gov.decideException(a.id, { decision: 'uphold', by: 'cco', justification: 'short' }), /justification/);
    const d = gov.decideException(a.id, { decision: 'uphold', by: 'cco', justification: 'Counterparty has no passport; block stands.' });
    assert.equal(d.status, 'decided');
    assert.throws(() => gov.decideException(a.id, { decision: 'remediate', by: 'cco', justification: 'x'.repeat(30) }), /already decided/);
    assert.throws(() => gov.decideException('exc-nope', { decision: 'uphold', by: 'cco', justification: 'x'.repeat(30) }), /unknown exception/);
  });

  it('a sanctions hit closed as false positive must cite the screening evidence', () => {
    const { gov } = mk();
    const s = gov.openException({ source: 'travel_rule_fail', ref: h('t3'), reason_code: 4, owner: 'compliance' });
    assert.throws(() => gov.decideException(s.id, { decision: 'false_positive', by: 'cco', justification: 'Looks fine to me after a call.' }), /screening/);
    assert.equal(gov.decideException(s.id, { decision: 'false_positive', by: 'cco', justification: 'Name match only; screening list entry has different birth date.' }).decision, 'false_positive');
  });

  it('overdue filter follows the clock; the queue rebuilds from the log and the chain verifies', () => {
    const { gov, clock, key, logPath } = mk();
    failsOf(SNAP.transfers).forEach((f) => gov.openException({ ...f, owner: 'compliance' }));
    clock.t = T0 + 25 * 3600;
    assert.deepEqual(gov.exceptions({ overdue: true }).map((e) => e.reason_code), [4]);
    const s = gov.exceptions({ overdue: true })[0];
    gov.decideException(s.id, { decision: 'escalate', by: 'cco', justification: 'Sanctions hit escalated to the supervisor per policy.' });
    assert.equal(gov.exceptions({ open: true }).length, 2);
    const again = new DisclosureGovernance(key, logPath, () => clock.t);
    assert.equal(again.exceptions({ open: true }).length, 2);
    assert.equal(again.exceptions().find((e) => e.id === s.id)!.decision, 'escalate');
    assert.equal(DisclosureGovernance.verifyLog(logPath).ok, true);
    const decide = again.log().find((e) => e.event === 'EXCEPTION_DECIDE')!;
    assert.equal(decide.detail.overdue_when_decided, true);
  });
});

describe('role views', () => {
  it('compliance sees only FAILs with reason, roots and policy hash', () => {
    const v: any = view('compliance', SNAP);
    assert.equal(v.failed.length, 3);
    assert.deepEqual(Object.keys(v.failed[0]).sort(), ['beneficiary_root', 'evaluated_at', 'fail_reason', 'originator_root', 'policy_hash', 'reason', 'transfer_id']);
    const ids = new Set(v.failed.map((t: any) => t.transfer_id));
    assert.ok(!ids.has(h('t1')) && !ids.has(h('t4')), 'PASS/RELEASED transfer leaked into compliance view');
    assert.equal('totals' in v || 'buckets' in v, false);
  });

  it('risk sees only aggregates per period: no ids, roots or policy hashes', () => {
    const v: any = view('risk', SNAP, { period: 'month' });
    assert.deepEqual(v.buckets, [
      { period: '2027-01', pass: 1, fail: 2, released: 1, fail_by_reason: { 3: 1, 4: 1 } },
      { period: '2027-02', pass: 1, fail: 1, released: 0, fail_by_reason: { 1: 1 } },
    ]);
    const blob = JSON.stringify(v);
    for (const t of SNAP.transfers) for (const k of ['transfer_id', 'originator_root', 'beneficiary_root', 'policy_hash'] as const) assert.ok(!blob.includes(t[k]), `${k} leaked into risk view`);
    assert.equal((view('risk', SNAP, { period: 'day' }) as any).buckets.length, 3);
  });

  it('auditor sees every transfer; regulator has no bulk view', () => {
    assert.equal((view('auditor', SNAP) as any).transfers.length, 5);
    assert.throws(() => view('regulator', SNAP), /disclosure grant/);
  });

  it('views are logged (ROLE_VIEW, counts only) and snapshots are validated', () => {
    const { gov } = mk();
    gov.roleView('compliance', 'analyst-1', SNAP);
    const e = gov.log().at(-1)!;
    assert.equal(e.event, 'ROLE_VIEW');
    assert.equal(e.grant_id, 'compliance');
    assert.equal(e.detail.rows, 3);
    assert.ok(!JSON.stringify(e).includes(h('t2')), 'the log entry carries counts, not the rows');
    assert.throws(() => gov.roleView('risk', '', SNAP), /actor/);
    assert.throws(() => parseSnapshot({ transfers: [{ ...tr('9', 2, 9) }] }), /fail_reason/);
    assert.throws(() => parseSnapshot({ transfers: [{ ...tr('9', 2, 1), transfer_id: 'Maria' }] }), /32 bytes hex/);
  });
});
