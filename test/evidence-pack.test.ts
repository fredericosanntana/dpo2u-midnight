import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DisclosureGovernance } from '../src/disclosure/governance.js';
import { buildPack, verifyPack, type Attestation } from '../src/evidence/pack.js';

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
    const m = buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: att, disclosureLogPath: log, generatedAt: '2026-11-06T00:00:00Z' });
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
    assert.throws(() => buildPack({ outDir: out, vaspName: 'Acme Corretora Ltda', attestations: att, disclosureLogPath: log, generatedAt: 'x' }), /fictitious/);
  });
  it('refuses to pack a log whose chain is broken', () => {
    const { log, out } = fixture();
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('ISSUE', 'REVOKE'));
    assert.throws(() => buildPack({ outDir: out, vaspName: 'Example VASP Ltda (fictitious)', attestations: att, disclosureLogPath: log, generatedAt: 'x' }), /chain verification/);
  });
});
