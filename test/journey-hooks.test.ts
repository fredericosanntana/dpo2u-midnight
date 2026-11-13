/**
 * Journey hooks: E3 passport from the gateway queue, E6 one gate per institution, E7 evidence pack
 * for the gateway. No network; the passport path runs the compiled PsavPassport in the simulator.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import * as Passport from '../build/PsavPassport/contract/index.js';
import { parseQueuePayload, parsePreimages, issueFromQueue, expectedVerdict, QUEUE_FIELDS, QUEUE_FIELD_MAP } from '../scripts/lib/passport-queue.js';
import { institutionGateInputs, recordInstitutionGate, institutionGate } from '../scripts/lib/institutions.js';
import { readGateDeployment } from '../scripts/lib/travel-rule-v10.js';
import { buildEvidencePack } from '../src/evidence/gateway.js';
import { DisclosureGovernance } from '../src/disclosure/governance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hx = (s: string) => createHash('sha256').update(s).digest('hex');
const pad = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s).copy(b); return new Uint8Array(b); };
const T0 = 1_800_000_000, CPK = '0'.repeat(64);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jh-'));

// ── E3 ──
const PRE = { partnerId: hx('partner'), commitSalt: hx('salt'), evidenceHash: hx('evidence'), reviewerSigHash: hx('reviewer-sig'), rules: [{ origin: 1, verdict: 1 }, { origin: 1, verdict: 1 }, { origin: 2, verdict: 1 }] };
const lc = (v: string, l: string) => Buffer.from(Passport.pureCircuits.labeled_commit(Buffer.from(v, 'hex'), Buffer.from(PRE.commitSalt, 'hex'), pad(l))).toString('hex');
function payloadFor(pre: any = PRE, over: any = {}) {
  return { passportId: 'vasp:queued-partner', partnerCommit: lc(pre.partnerId, 'partner'), packHash: hx('pack'), packVersion: '1.0.0', tier: 1,
    issuedAt: T0 - 3600, expiresAt: T0 - 3600 + 31_536_000, verdict: 'PASS', ruleCounts: { machine: 2, human: 1, third_party: 0 },
    evidenceCommit: lc(pre.evidenceHash, 'evidence'), reviewerCommit: pre.reviewerSigHash ? lc(pre.reviewerSigHash, 'reviewer') : '0'.repeat(64), ...over };
}
async function issueInSimulator(args: readonly unknown[], witnesses: Record<string, unknown>) {
  const sec = pad('issuer');
  const w: any = { owner_secret: (x: any) => [x.privateState, sec], sponsor_secret: () => { throw new Error('unused'); },
    ...Object.fromEntries(Object.entries(witnesses).map(([k, v]) => [k, (x: any) => [x.privateState, v]])) };
  const c = new Passport.Contract(w);
  const init = (await c.initialState(createConstructorContext({}, CPK), Passport.pureCircuits.owner_commitment(sec))).currentContractState;
  const r = await c.circuits.issuePassport(createCircuitContext({ circuitId: 'i', contractAddress: '00'.repeat(31) + '01', coinPublicKeyOrZswapState: CPK, contractState: init, privateState: {}, time: T0 } as any), ...(args as any[]));
  return { result: Number(r.result), L: Passport.ledger(r.context.callContext.currentQueryContext.state) };
}

describe('E3: passport from the gateway queue', () => {
  it('every queue field is required and mapped; derived fields are documented as computed in-circuit', () => {
    assert.deepEqual(Object.keys(QUEUE_FIELD_MAP).sort(), [...QUEUE_FIELDS].sort());
    for (const k of ['partnerCommit', 'evidenceCommit', 'reviewerCommit', 'ruleCounts', 'verdict'] as const) assert.match(QUEUE_FIELD_MAP[k], /computed in-circuit/);
    const p = payloadFor();
    for (const k of QUEUE_FIELDS) { const q: any = { ...p }; delete q[k]; assert.throws(() => parseQueuePayload(q), new RegExp(`missing: ${k}`)); }
    assert.throws(() => parseQueuePayload({ ...p, expiresAt: p.expiresAt + 1 }), /expiresAt must be issuedAt \+ 31536000/);
    assert.throws(() => parseQueuePayload({ ...p, tier: 7 }), /tier must be 0..3/);
    assert.throws(() => parseQueuePayload({ ...p, packHash: 'XY' }), /packHash must be 32 bytes/);
    assert.throws(() => parseQueuePayload({ ...p, verdict: 'OK' }), /verdict must be/);
  });

  it('a matching payload issues on chain exactly what the gateway enqueued', async () => {
    const q = parseQueuePayload(payloadFor());
    const r = issueFromQueue(Passport as any, q, parsePreimages(PRE));
    const { result, L } = await issueInSimulator(r.args, r.witnesses);
    assert.equal(result, 1);
    assert.equal(r.expectedVerdict, 1);
    const id = q.passportId;
    assert.deepEqual(L.partner_commit.lookup(id), q.partnerCommit);
    assert.deepEqual(L.evidence_commit.lookup(id), q.evidenceCommit);
    assert.deepEqual(L.reviewer_commit.lookup(id), q.reviewerCommit);
    assert.equal(Number(L.machine_rules.lookup(id)), 2);
    assert.equal(Number(L.human_rules.lookup(id)), 1);
    assert.equal(Number(L.expires_at.lookup(id)), q.expiresAt);
  });

  it('refuses a payload whose commits, counts or verdict do not match the preimages', () => {
    const pre = parsePreimages(PRE);
    const bad = (over: any, rx: RegExp) => assert.throws(() => issueFromQueue(Passport as any, parseQueuePayload(payloadFor(PRE, over)), pre), rx);
    bad({ partnerCommit: hx('other') }, /partnerCommit does not match/);
    bad({ evidenceCommit: hx('other') }, /evidenceCommit does not match/);
    bad({ reviewerCommit: '0'.repeat(64) }, /reviewerCommit does not match/);
    bad({ ruleCounts: { machine: 3, human: 0, third_party: 0 } }, /ruleCounts/);
    bad({ verdict: 'REVIEW' }, /verdict 3 does not match the rules \(1\)/);
    assert.throws(() => parsePreimages({ ...PRE, rules: [] }), /1..16 rules/);
  });

  it('the off-chain verdict rule equals the circuit on PASS, FAIL and REVIEW cases', async () => {
    const cases = [
      { tier: 0, rules: [{ origin: 1, verdict: 1 }], reviewer: null },
      { tier: 1, rules: [{ origin: 1, verdict: 1 }, { origin: 2, verdict: 3 }], reviewer: hx('r') },
      { tier: 1, rules: [{ origin: 1, verdict: 1 }], reviewer: null },
      { tier: 2, rules: [{ origin: 1, verdict: 2 }, { origin: 3, verdict: 1 }], reviewer: hx('r') },
    ];
    for (const c of cases) {
      const pre = { ...PRE, rules: c.rules, reviewerSigHash: c.reviewer };
      const v = expectedVerdict(c.tier, c.rules, !!c.reviewer);
      const counts = { machine: c.rules.filter((r) => r.origin === 1).length, human: c.rules.filter((r) => r.origin === 2).length, third_party: c.rules.filter((r) => r.origin === 3).length };
      const win = c.tier <= 1 ? 31_536_000 : 2_678_400;
      const q = parseQueuePayload(payloadFor(pre, { tier: c.tier, expiresAt: T0 - 3600 + win, verdict: v, ruleCounts: counts }));
      const r = issueFromQueue(Passport as any, q, parsePreimages(pre));
      assert.equal((await issueInSimulator(r.args, r.witnesses)).result, v, JSON.stringify(c));
    }
  });

  it('--from-queue --plan validates the payload and the preimages without a network', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'q.json'), JSON.stringify(payloadFor()));
    fs.writeFileSync(path.join(d, 'pre.json'), JSON.stringify(PRE), { mode: 0o600 });
    const a = (n: number) => n.toString(16).padStart(64, '0');
    fs.writeFileSync(path.join(d, 'dep.json'), JSON.stringify({ contracts: { TravelRuleGate: { contractAddress: a(1), codeVersion: 'v10', links: { PsavPassport: a(2), ComplianceRegistry: a(3) } } } }));
    const out = execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'travel-rule-v10.ts'), 'issue-passport', '--from-queue', path.join(d, 'q.json'), '--passport-witness', path.join(d, 'pre.json'), '--deployment', path.join(d, 'dep.json'), '--plan'], { cwd: ROOT, env: { ...process.env, MIDNIGHT_NETWORK: 'preview' } }).toString();
    const plan = JSON.parse(out).plan;
    assert.equal(plan.circuit, 'issuePassport');
    assert.equal(plan.args.expected_verdict, 1);
    assert.match(plan.args.payload_sha256, /^[0-9a-f]{64}$/);
    fs.chmodSync(path.join(d, 'pre.json'), 0o644);
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'travel-rule-v10.ts'), 'issue-passport', '--from-queue', path.join(d, 'q.json'), '--passport-witness', path.join(d, 'pre.json'), '--deployment', path.join(d, 'dep.json'), '--plan'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, MIDNIGHT_NETWORK: 'preview' } }), /must be mode 600/);
  });
});

// ── E6 ──
describe('E6: one TravelRuleGate per institution', () => {
  it('inputs: the institution approver commitment is required; ids are checked', () => {
    const c = 'cd'.repeat(32);
    const i = institutionGateInputs({ institution: 'vasp-alpha', selfCompanyId: 'company:alpha', approverCommit: c, thresholdCents: '50000' }, {});
    assert.equal(Buffer.from(i.approverCommit).toString('hex'), c);
    assert.equal(i.thresholdCents, 50_000n);
    assert.throws(() => institutionGateInputs({ institution: 'vasp-alpha', selfCompanyId: 'x' }, {}), /approver commitment is required/);
    assert.throws(() => institutionGateInputs({ institution: 'vasp-alpha', approverCommit: c }, {}), /self-company-id/);
    assert.throws(() => institutionGateInputs({ institution: 'Banco X', selfCompanyId: 'x', approverCommit: c }, {}), /institution id/);
    assert.equal(institutionGateInputs({ institution: 'vasp-beta', selfCompanyId: 'x' }, { DPO2U_APPROVER_COMMIT: c }).thresholdCents, 100_000n);
  });

  it('recorded under institutions.<id>; travel-rule-v10 --institution reads that gate with the shared callees', () => {
    const a = (n: number) => n.toString(16).padStart(64, '0');
    const dep: any = { network: 'preview', contracts: { PsavPassport: { contractAddress: a(2) }, ComplianceRegistry: { contractAddress: a(3) },
      TravelRuleGate: { contractAddress: a(1), codeVersion: 'v10', links: { PsavPassport: a(2), ComplianceRegistry: a(3) } } } };
    recordInstitutionGate(dep, 'vasp-alpha', { contractAddress: a(9), codeVersion: 'v10', accessControl: 'owner-v1', links: { PsavPassport: a(2), ComplianceRegistry: a(3) }, institution: 'vasp-alpha' });
    assert.equal(institutionGate(dep, 'vasp-alpha').contractAddress, a(9));
    const f = path.join(tmp(), 'dep.json'); fs.writeFileSync(f, JSON.stringify(dep));
    const g = readGateDeployment(ROOT, 'preview', f, 'vasp-alpha');
    assert.equal(g.gate, a(9)); assert.equal(g.institution, 'vasp-alpha');
    assert.deepEqual(g.links, { PsavPassport: a(2), ComplianceRegistry: a(3) });
    assert.equal(readGateDeployment(ROOT, 'preview', f).gate, a(1));
    assert.throws(() => readGateDeployment(ROOT, 'preview', f, 'vasp-beta'), /institution vasp-beta has no TravelRuleGate/);
  });
});

// ── E7 ──
describe('E7: evidence pack for the gateway', () => {
  function clientDir(root: string, id: string) {
    const d = path.join(root, id); fs.mkdirSync(path.join(d, 'disclosure'), { recursive: true });
    fs.writeFileSync(path.join(d, 'client.json'), JSON.stringify({ name: 'Example VASP Ltda (fictitious)' }));
    const t1 = hx('t1'), t2 = hx('t2'), t3 = hx('t3');
    const att = (t: string, v: any) => ({ id: 'a-' + t.slice(0, 6), type: 'travel_rule_verdict', transfer_id: t, verdict: v, reason_code: v === 'FAIL' ? 3 : 0, originator_root: hx('o' + t), beneficiary_root: hx('b' + t), policy_hash: hx('policy'), source: 'simulator', contract_address: null, tx_hash: null });
    fs.writeFileSync(path.join(d, 'attestations.json'), JSON.stringify([att(t1, 'PASS'), att(t2, 'FAIL'), att(t3, 'RELEASED')]));
    fs.writeFileSync(path.join(d, 'inputs.json'), JSON.stringify(['party_data', 'sanctions_list', 'threshold', 'registry_attestation'].map((n) => ({ name: n, source: 'fictitious', retrievedAt: '2026-11-13T00:00:00Z', signedBy: null, hash: hx(n) }))));
    const g = new DisclosureGovernance(randomBytes(32), path.join(d, 'disclosure', 'access-log.jsonl'), () => 1000);
    g.issue({ grant_id: 'g-1', supervisor: 'BCB (fictitious)', legal_basis: 'fictitious inquiry', transfer_ids: [t1, t2], parties: ['originator'], scope: 1, expires_at: 2000 });
    return { t1, t2, t3 };
  }

  it('by grant: packs the grant transfers, verifies, writes nothing to stdout', () => {
    const root = tmp(); const { t1, t2 } = clientDir(root, 'vasp-alpha');
    const logs: unknown[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a); };
    try {
      const r = buildEvidencePack({ clientId: 'vasp-alpha', grantId: 'g-1', outDir: path.join(root, 'out'), dataRoot: root, repoRoot: null, generatedAt: '2026-11-13T00:00:00Z' });
      assert.deepEqual(r.transferIds.sort(), [t1, t2].sort());
      assert.deepEqual(r.verify, { ok: true, errors: [] });
      assert.equal(r.manifest.attestation_count, 2);
    } finally { console.log = orig; }
    assert.equal(logs.length, 0, 'no CLI output');
  });

  it('by transfer ids, with due diligence; refuses ids outside the grant, unknown ids and unsafe client ids', () => {
    const root = tmp(); const { t1, t3 } = clientDir(root, 'vasp-alpha');
    const r = buildEvidencePack({ clientId: 'vasp-alpha', transferIds: [t3], outDir: path.join(root, 'o1'), dataRoot: root, repoRoot: ROOT });
    assert.equal(r.manifest.attestation_count, 1);
    assert.ok(r.manifest.files.some((f: any) => f.path === 'due-diligence/cco-checklist.json'));
    assert.equal(r.verify.ok, true);
    assert.throws(() => buildEvidencePack({ clientId: 'vasp-alpha', grantId: 'g-1', transferIds: [t3], outDir: path.join(root, 'o2'), dataRoot: root, repoRoot: null }), /outside grant g-1/);
    assert.throws(() => buildEvidencePack({ clientId: 'vasp-alpha', transferIds: [hx('nope')], outDir: path.join(root, 'o3'), dataRoot: root, repoRoot: null }), /no attestation for transfers/);
    assert.throws(() => buildEvidencePack({ clientId: 'vasp-alpha', grantId: 'g-x', outDir: path.join(root, 'o4'), dataRoot: root, repoRoot: null }), /no ISSUE entry/);
    assert.throws(() => buildEvidencePack({ clientId: '../etc', outDir: path.join(root, 'o5'), dataRoot: root }), /clientId must be/);
    assert.throws(() => buildEvidencePack({ clientId: 'vasp-zeta', outDir: path.join(root, 'o6'), dataRoot: root }), /client.json missing/);
    assert.ok(t1);
  });
});
