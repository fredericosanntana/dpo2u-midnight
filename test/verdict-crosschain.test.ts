/**
 * Cross-chain vectors for the common verdict format v1 (docs/VERDICT-FORMAT.md).
 *
 * test/vectors/verdict-v1.json comes from the compiled TravelRuleGate in the simulator, so every
 * vector there has block/tx = null and a signed sanctions list. Readers on other chains (Soroban in
 * dpo2u-stellar, Solidity in dpo2u-avalanche) also need the other shapes a real export produces:
 * a verdict anchored to a block and tx, and one without the optional `sanctions` (pre-signed-list
 * gate). This file derives those shapes from the simulator vectors, with fictitious anchors, and
 * pins canonical JSON + digest. The same JSON file is copied verbatim into the other repos' tests.
 * Regenerate with UPDATE_VECTORS=1 (only when the format version changes).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJson, verdictDigest, checkVerdict, VERDICT_FORMAT } from '../scripts/lib/verdict.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors');
const BASE = path.join(DIR, 'verdict-v1.json');
const OUT = path.join(DIR, 'verdict-v1-crosschain.json');

// Fictitious anchors (not real preview blocks): fixed so the digests are reproducible.
const anchor = (n: number) => ({
  source_chain: 'midnight:preview',
  block: { height: 81_000 + n, hash: createHash('sha256').update('fictitious-block:' + n).digest('hex') },
  tx: createHash('sha256').update('fictitious-tx:' + n).digest('hex'),
});

function derive() {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8')).vectors as any[];
  const by = (n: string) => structuredClone(base.find((x) => x.name === n).verdict);
  const cases: [string, any][] = [];
  // The six simulator vectors as they are (unanchored, with sanctions).
  for (const x of base) cases.push([x.name, structuredClone(x.verdict)]);
  // Anchored to a block and tx, as export-verdict.ts --tx produces.
  cases.push(['pass-released-anchored', { ...by('pass-released'), ...anchor(1) }]);
  cases.push(['pass-not-released-anchored', { ...by('pass-not-released'), ...anchor(2) }]);
  cases.push(['fail-4-sanctions-hit-anchored', { ...by('fail-4-sanctions-hit'), ...anchor(3) }]);
  // Without the optional sanctions field (gate that does not record signed lists).
  const noSanctions = (v: any) => { delete v.sanctions; return v; };
  cases.push(['pass-released-anchored-no-sanctions', noSanctions({ ...by('pass-released'), ...anchor(4) })]);
  cases.push(['fail-1-missing-party-info-no-sanctions', noSanctions(by('fail-1-missing-party-info'))]);
  return cases.map(([name, verdict]) => ({ name, verdict, canonical: canonicalJson(verdict), digest: verdictDigest(verdict) }));
}

describe('verdict format v1, cross-chain vectors', () => {
  it('derived vectors are pinned in test/vectors/verdict-v1-crosschain.json', () => {
    const got = derive();
    if (process.env.UPDATE_VECTORS === '1') fs.writeFileSync(OUT, JSON.stringify({ format: VERDICT_FORMAT, generated_by: 'test/verdict-crosschain.test.ts (from verdict-v1.json, fictitious anchors)', vectors: got }, null, 2) + '\n');
    const want = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    assert.equal(want.format, VERDICT_FORMAT);
    assert.deepEqual(got, want.vectors);
  });

  it('every vector passes the format check and digest = sha256(canonical)', () => {
    const { vectors } = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    assert.equal(vectors.length, 11);
    for (const x of vectors) {
      assert.deepEqual(checkVerdict(x.verdict), [], x.name);
      assert.equal(x.digest, createHash('sha256').update(x.canonical).digest('hex'), x.name);
    }
    // Anchoring changes the digest: a reader that drops block/tx would not match.
    const d = Object.fromEntries(vectors.map((x: any) => [x.name, x.digest]));
    assert.notEqual(d['pass-released'], d['pass-released-anchored']);
    assert.notEqual(d['pass-released-anchored'], d['pass-released-anchored-no-sanctions']);
  });
});
