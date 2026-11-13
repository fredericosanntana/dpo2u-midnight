import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DisclosureGovernance, purposeHash, type DataSource } from '../src/disclosure/governance.js';

const vault: DataSource = {
  open: (t, p, f) => (t === 't1' ? { value: `${p}:${f}:fictitious`, salt: 'salt-' + f } : undefined),
};
function mk(t0 = 1_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
  const clock = { t: t0 };
  const gov = new DisclosureGovernance(randomBytes(32), path.join(dir, 'log.jsonl'), () => clock.t);
  return { dir, clock, gov, logPath: path.join(dir, 'log.jsonl') };
}
const issue = (gov: DisclosureGovernance, ttl = 600) => gov.issue({
  supervisor: 'BCB', legal_basis: 'Fictitious supervisory request 0001/2026', transfer_ids: ['t1'],
  parties: ['originator'], scope: 1, expires_at: 1_000 + ttl, grant_id: 'g-bcb',
});
const req = (fields: any[], extra: any = {}) => ({ transfer_id: 't1', party: 'originator' as const, fields, ...extra });

describe('disclosure governance', () => {
  it('BCB sees only its scope; out-of-scope field/party/transfer are denied and logged', () => {
    const { gov } = mk();
    const tok = issue(gov);
    const ok = gov.access(tok, req(['name']), vault);
    assert.ok(ok.ok && Object.keys(ok.fields).join() === 'name');
    for (const [r, why] of [
      [req(['name', 'account']), 'field_out_of_scope:account'],
      [req(['document']), 'field_out_of_scope:document'],
      [req(['name'], { party: 'beneficiary' }), 'party_out_of_scope'],
      [req(['name'], { transfer_id: 't2' }), 'transfer_out_of_scope'],
    ] as const) {
      const d = gov.access(tok, r as any, vault);
      assert.deepEqual(d, { ok: false, reason: why });
    }
    assert.equal(gov.log().filter((e) => e.event === 'ACCESS_DENIED').length, 4);
  });

  it('expires: access after expiry is denied and logged', () => {
    const { gov, clock } = mk();
    const tok = issue(gov, 600);
    assert.ok(gov.access(tok, req(['name']), vault).ok);
    clock.t = 1_600;
    assert.deepEqual(gov.access(tok, req(['name']), vault), { ok: false, reason: 'expired' });
    assert.equal(gov.log().at(-1)!.event, 'ACCESS_DENIED');
    assert.equal(gov.log().at(-1)!.detail.reason, 'expired');
  });

  it('revocation takes effect immediately and is logged', () => {
    const { gov, clock } = mk();
    const tok = issue(gov);
    assert.ok(gov.access(tok, req(['name']), vault).ok);
    clock.t = 1_100;
    gov.revoke('g-bcb', 'request withdrawn');
    assert.deepEqual(gov.access(tok, req(['name']), vault), { ok: false, reason: 'revoked' });
    assert.deepEqual(gov.log().map((e) => e.event), ['ISSUE', 'ACCESS_GRANTED', 'REVOKE', 'ACCESS_DENIED']);
  });

  it('forged or tampered credential is rejected', () => {
    const { gov } = mk();
    const tok = issue(gov);
    const [p, s] = tok.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.scope = 15;
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + s;
    assert.deepEqual(gov.access(forged, req(['document']), vault), { ok: false, reason: 'invalid_credential' });
    const other = mk().gov; // different issuer key
    assert.deepEqual(other.access(tok, req(['name']), vault), { ok: false, reason: 'invalid_credential' });
  });

  it('issue requires legal basis, non-empty scope, future expiry', () => {
    const { gov } = mk();
    const base = { supervisor: 'BCB', legal_basis: 'x', transfer_ids: ['t1'], parties: ['originator' as const], scope: 1, expires_at: 2_000 };
    assert.throws(() => gov.issue({ ...base, legal_basis: ' ' }), /legal_basis/);
    assert.throws(() => gov.issue({ ...base, scope: 0 }), /scope/);
    assert.throws(() => gov.issue({ ...base, expires_at: 500 }), /future/);
  });

  it('log is hash-chained: verifies, survives reload, and detects tampering', () => {
    const { gov, logPath, clock } = mk();
    const tok = issue(gov);
    gov.access(tok, req(['name']), vault);
    gov.revoke('g-bcb', 'done');
    gov.access(tok, req(['name']), vault);
    const v = DisclosureGovernance.verifyLog(logPath);
    assert.ok(v.ok && v.entries === 4 && v.head === gov.head());
    // reload keeps revocation state and continues the chain
    const gov2 = new DisclosureGovernance(Buffer.alloc(32, 1), logPath, () => clock.t);
    assert.equal(gov2.head(), gov.head());
    // tamper: flip a denial into a grant
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    lines[3] = lines[3].replace('ACCESS_DENIED', 'ACCESS_GRANTED');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    const bad = DisclosureGovernance.verifyLog(logPath);
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /hash mismatch at 3/);
    // tamper: delete an entry in the middle
    fs.writeFileSync(logPath, [lines[0], lines[2], lines[3]].join('\n') + '\n');
    assert.equal(DisclosureGovernance.verifyLog(logPath).ok, false);
  });

  it('fails closed: a tampered log is rejected on load (REVOKE cannot be edited away)', () => {
    const { gov, logPath, clock } = mk();
    issue(gov);
    gov.revoke('g-bcb', 'request withdrawn');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    assert.match(lines[1], /"event":"REVOKE"/);
    lines[1] = lines[1].replace('"event":"REVOKE"', '"event":"ACCESS_GRANTED"');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    assert.throws(() => new DisclosureGovernance(Buffer.alloc(32, 1), logPath, () => clock.t), /failed verification/);
    // an empty or missing log is accepted
    const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disc-')), 'log.jsonl');
    assert.ok(DisclosureGovernance.verifyLog(empty).ok);
    fs.writeFileSync(empty, '');
    assert.ok(DisclosureGovernance.verifyLog(empty).ok);
    assert.doesNotThrow(() => new DisclosureGovernance(Buffer.alloc(32, 1), empty, () => clock.t));
  });

  it('key file must be mode 600', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k-')), 'k');
    fs.writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o644 });
    assert.throws(() => DisclosureGovernance.loadKey(f), /mode 600/);
  });

  it('ISSUE logs the purpose_hash for TravelRuleGate.grantDisclosure; it binds the legal basis', () => {
    const { gov } = mk();
    issue(gov);
    const e = gov.log().find((x) => x.event === 'ISSUE')!;
    const terms = { grant_id: 'g-bcb', supervisor: 'BCB', legal_basis: 'Fictitious supervisory request 0001/2026', transfer_ids: ['t1'], parties: ['originator' as const], scope: 1, expires_at: 1_600 };
    assert.equal(e.detail.purpose_hash, purposeHash(terms));
    assert.match(String(e.detail.purpose_hash), /^[0-9a-f]{64}$/);
    assert.notEqual(purposeHash({ ...terms, legal_basis: 'another basis' }), purposeHash(terms));
  });
});
