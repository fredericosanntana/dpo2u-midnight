import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DisclosureGovernance } from '../src/disclosure/governance.js';
import { buildPack, verifyPack, type Attestation, type PackInputRecord } from '../src/evidence/pack.js';

const hx = (s: string) => createHash('sha256').update(s).digest('hex');
const INPUTS: PackInputRecord[] = [
  { name: 'party_data', source: 'VASP vault (fictitious)', retrievedAt: '2026-11-13T00:00:00Z', signedBy: null, hash: hx('party') },
  { name: 'sanctions_list', source: 'screening provider (fictitious)', retrievedAt: '2026-11-13T00:00:00Z', signedBy: 'provider-key:fictitious', hash: hx('list') },
  { name: 'threshold', source: 'TravelRuleGate.threshold_cents', retrievedAt: '2026-11-13T00:00:00Z', signedBy: null, hash: hx('100000') },
  { name: 'registry_attestation', source: 'ComplianceRegistry.attestation_verdicts', retrievedAt: '2026-11-13T00:00:00Z', signedBy: null, hash: hx('att') },
];

const att: Attestation[] = [{ id: 'a1', type: 'travel_rule_verdict', transfer_id: 'aa', verdict: 'PASS', reason_code: 0, originator_root: 'bb', beneficiary_root: 'cc', source: 'simulator', contract_address: null, tx_hash: null }];
function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));
  const log = path.join(d, 'log.jsonl');
  const g = new DisclosureGovernance(randomBytes(32), log, () => 1000);
  g.issue({ supervisor: 'BCB', legal_basis: 'fictitious', transfer_ids: ['t'], parties: ['originator'], scope: 1, expires_at: 2000 });
  return { d, log, out: path.join(d, 'pack') };
}

describe('evidence pack', () => {
  it('builds manifest + README, verifies, and detects tampering in any file', () => {
    const { log, out } = fixture();
    const m = buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: att, disclosureLogPath: log, generatedAt: '2026-11-06T00:00:00Z', inputs: INPUTS });
    assert.equal(m.files.length, 4);
    assert.ok(fs.existsSync(path.join(out, 'README.md')) && /FICTITIOUS/.test(fs.readFileSync(path.join(out, 'README.md'), 'utf8')));
    assert.deepEqual(verifyPack(out), { ok: true, errors: [] });
    fs.appendFileSync(path.join(out, 'attestations.json'), ' ');
    const bad = verifyPack(out);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /hash mismatch attestations.json/.test(e)));
  });
  it('refuses a VASP name that is not labelled fictitious', () => {
    const { log, out } = fixture();
    assert.throws(() => buildPack({ outDir: out, vaspName: 'Acme Corretora Ltda', attestations: att, disclosureLogPath: log, generatedAt: 'x', inputs: INPUTS }), /fictitious/);
  });
  it('refuses to pack a log whose chain is broken', () => {
    const { log, out } = fixture();
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('ISSUE', 'REVOKE'));
    assert.throws(() => buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: att, disclosureLogPath: log, generatedAt: 'x', inputs: INPUTS }), /chain verification/);
  });
});

describe('evidence pack: due diligence', () => {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  function ddFixture() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkdd-'));
    const log = path.join(d, 'log.jsonl');
    const g = new DisclosureGovernance(randomBytes(32), log, () => 1000);
    g.issue({ supervisor: 'BCB', legal_basis: 'fictitious', transfer_ids: ['t'], parties: ['originator'], scope: 1, expires_at: 2000 });
    const e = g.openException({ source: 'travel_rule_fail', ref: 'aa'.repeat(32), reason_code: 3, owner: 'compliance', policy_hash: 'dd'.repeat(32) });
    g.decideException(e.id, { decision: 'uphold', by: 'cco', justification: 'Counterparty without passport; block stands.' });
    const out = path.join(d, 'pack');
    const m = buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: [{ ...att[0], policy_hash: 'dd'.repeat(32) }], disclosureLogPath: log,
      generatedAt: '2026-11-13T00:00:00Z', generator: { repo_commit: 'abc1234' }, dueDiligence: { repoRoot: ROOT }, inputs: INPUTS });
    return { out, m };
  }

  it('adds every due-diligence artifact, all hashed in the manifest, and verifies', () => {
    const { out, m } = ddFixture();
    const paths = m.files.map((f: any) => f.path);
    for (const f of ['architecture.md', 'circuit-spec.json', 'circuit-spec.md', 'data-flow.md', 'disclosure-governance.md', 'access-model.md', 'exceptions.json', 'key-management.md', 'change-management.json', 'change-management.md', 'cco-checklist.json', 'cco-checklist.md']) {
      assert.ok(paths.includes(`due-diligence/${f}`), `missing due-diligence/${f}`);
    }
    assert.deepEqual(verifyPack(out), { ok: true, errors: [] });
  });

  it('circuit spec comes from the code: gate public/private split, gating, cross-contract calls, verifier keys', () => {
    const { out } = ddFixture();
    const specs = JSON.parse(fs.readFileSync(path.join(out, 'due-diligence', 'circuit-spec.json'), 'utf8'));
    assert.equal(specs.length, fs.readdirSync(path.join(ROOT, 'compact')).filter((f) => f.endsWith('.compact')).length);
    const gate = specs.find((s: any) => s.contract === 'TravelRuleGate');
    assert.ok(gate.private_witnesses.some((w: any) => w.name === 'transfer_amount'));
    assert.ok(!gate.public_ledger.some((l: any) => /amount/.test(l.name)), 'amount must not be public');
    const c = (n: string) => gate.circuits.find((x: any) => x.name === n);
    assert.equal(c('approveDisclosure').gate, 'approver');
    assert.equal(c('grantDisclosure').gate, 'owner');
    assert.deepEqual(c('evaluateTransfer').calls, ['passport.isValid']);
    assert.deepEqual(c('releaseTransfer').calls, ['registry.hasAttestation']);
    assert.match(c('evaluateTransfer').verifier_key_sha256, /^[0-9a-f]{64}$/);
    const reg = specs.find((s: any) => s.contract === 'ComplianceRegistry');
    assert.ok(reg.private_witnesses.some((w: any) => w.name === 'score_salt') && !reg.public_ledger.some((l: any) => l.name === 'attestation_scores'));
  });

  it('exceptions, change record and policy hashes are carried; every checklist item points at pack files', () => {
    const { out } = ddFixture();
    const ex = JSON.parse(fs.readFileSync(path.join(out, 'due-diligence', 'exceptions.json'), 'utf8'));
    assert.equal(ex.length, 1);
    assert.equal(ex[0].decision, 'uphold');
    const ch = JSON.parse(fs.readFileSync(path.join(out, 'due-diligence', 'change-management.json'), 'utf8'));
    assert.equal(ch.repo_commit, 'abc1234');
    assert.match(ch.compiler, /compactc 0\.36/);
    assert.deepEqual(ch.policy_hashes_in_use, ['dd'.repeat(32)]);
    const cl = JSON.parse(fs.readFileSync(path.join(out, 'due-diligence', 'cco-checklist.json'), 'utf8'));
    assert.ok(cl.length >= 10 && cl.every((i: any) => i.artifacts.length > 0));
  });

  it('verify fails when a checklist artifact is removed or tampered', () => {
    const { out } = ddFixture();
    fs.appendFileSync(path.join(out, 'due-diligence', 'key-management.md'), '\nedited');
    assert.ok(verifyPack(out).errors.some((e) => /hash mismatch due-diligence\/key-management.md/.test(e)));
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    m.files = m.files.filter((f: any) => f.path !== 'due-diligence/exceptions.json');
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m));
    assert.ok(verifyPack(out).errors.some((e) => /artifact due-diligence\/exceptions.json not in the manifest/.test(e)));
  });
});

describe('evidence pack: declared scope, policy version and inputs', () => {
  const build = (over: any = {}) => {
    const { log, out } = fixture();
    return { out, m: buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: [{ ...att[0], policy_hash: 'ee'.repeat(32) }], disclosureLogPath: log, generatedAt: '2026-11-13T00:00:00Z', inputs: INPUTS, ...over }) as any };
  };
  const strip = (out: string, f: (m: any) => void) => { const p = path.join(out, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); f(m); fs.writeFileSync(p, JSON.stringify(m)); return verifyPack(out); };

  it('manifest carries scope text (with what is NOT covered), policyVersion = the verdicts policy_hash, and every input', () => {
    const { out, m } = build();
    assert.match(m.scope.text, /does NOT show/);
    assert.ok(m.scope.does_not_cover.includes('lawfulness of the processing'));
    assert.equal(m.policyVersion, 'ee'.repeat(32));
    assert.deepEqual(m.inputs.map((x: any) => x.name), ['party_data', 'sanctions_list', 'threshold', 'registry_attestation']);
    assert.deepEqual(verifyPack(out), { ok: true, errors: [] });
    assert.match(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), /sanctions_list \(from screening provider \(fictitious\), [^)]*signed by provider-key:fictitious\)/);
  });

  it('verify fails without scope, policyVersion or inputs, or with a policyVersion that does not match', () => {
    assert.ok(strip(build().out, (m) => delete m.scope).errors.some((e) => /scope.text missing/.test(e)));
    assert.ok(strip(build().out, (m) => delete m.policyVersion).errors.some((e) => /policyVersion missing/.test(e)));
    assert.ok(strip(build().out, (m) => delete m.inputs).errors.some((e) => /inputs\[\] missing/.test(e)));
    assert.ok(strip(build().out, (m) => { m.policyVersion = 'ff'.repeat(32); }).errors.some((e) => /does not match/.test(e)));
    assert.ok(strip(build().out, (m) => { delete m.inputs[1].signedBy; }).errors.some((e) => /signedBy must be/.test(e)));
  });

  it('build refuses a missing required input, a malformed input, a scope that claims everything, and mixed policy versions', () => {
    assert.throws(() => build({ inputs: INPUTS.filter((x) => x.name !== 'sanctions_list') }), /sanctions_list not declared/);
    assert.throws(() => build({ inputs: [...INPUTS.slice(1), { ...INPUTS[0], hash: 'abc' }] }), /hash must be sha256/);
    assert.throws(() => build({ scope: { text: 'This pack proves the transfer is fully compliant in every respect, end to end.' } }), /does NOT cover/);
    const { log, out } = fixture();
    assert.throws(() => buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: [{ ...att[0], policy_hash: 'aa'.repeat(32) }, { ...att[0], id: 'a2', policy_hash: 'bb'.repeat(32) }], disclosureLogPath: log, generatedAt: 'x', inputs: INPUTS }), /one pack per policy version/);
  });

  it('a pack whose verdicts carry no policy hash records policyVersion null explicitly', () => {
    const { log, out } = fixture();
    const m: any = buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: att, disclosureLogPath: log, generatedAt: 'x', inputs: INPUTS });
    assert.equal(m.policyVersion, null);
    assert.equal('policyVersion' in m, true);
    assert.deepEqual(verifyPack(out), { ok: true, errors: [] });
  });
});
