/**
 * Indexed (sorted) Merkle tree for in-circuit sanctions screening (TravelRuleGate v11): the tree the
 * provider signs and the paths the operator hands the circuit (witness sanctions_path). Pure part,
 * no compiled contract: the circuit-side hashes are cross-checked in test/travel-rule-gate.test.ts.
 * Design credit: ProofOrBluff (@realjohnny5i, github.com/bytewizard42i/ProofOrBluff).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SanctionsTree, pathRoot, screeningKey, rootBytes, sanctionsListRoot, treeForSignedRoot, readEntries, SANCTIONS_TREE_DEPTH, newPepper, pepperCommitment, screeningDigest, keyedEntries, parsePepper, type SanctionsListWitness } from '../scripts/lib/sanctions-list.js';
import { sanctionsTreeFor, sanctionsPepperFor } from '../scripts/lib/transfer-queue.js';

const hx = (s: string) => createHash('sha256').update(s).digest('hex');
const ENTRIES = Array.from({ length: 37 }, (_, i) => hx(`listed:${i}`));
const tree = new SanctionsTree(ENTRIES);
// What the circuit checks for one key: the path opens the root and value <= key < next (next 0 = none).
const proves = (t: SanctionsTree, key: bigint, p = t.path(key)) =>
  pathRoot(p) === t.root && p.leaf.value <= key && (p.leaf.next === 0n || key < p.leaf.next) && p.steps.length === SANCTIONS_TREE_DEPTH;

describe('sanctions indexed tree', () => {
  it('every listed key is a proven hit, and the path opens the root', () => {
    for (const h of ENTRIES) {
      const k = screeningKey(h);
      assert.ok(proves(tree, k), h);
      assert.equal(tree.path(k).leaf.value, k);
      assert.equal(tree.has(k), true);
    }
  });

  it('keys between, below and above the listed ones are proven non-members', () => {
    const ks = [...tree.keys];
    const probes = [1n, ks[0] - 1n, ks[0] + 1n, ks[10] + 1n, ks[ks.length - 1] + 1n, (1n << 128n) - 1n, screeningKey(hx('not listed'))];
    for (const k of probes) {
      assert.ok(proves(tree, k), String(k));
      assert.equal(tree.has(k), false);
      assert.notEqual(tree.path(k).leaf.value, k);
    }
    assert.equal(tree.path(1n).leaf.value, 0n);                  // sentinel leaf (0, smallest key)
    assert.equal(tree.path((1n << 128n) - 1n).leaf.next, 0n);    // last leaf (largest key, none)
  });

  it('a path cannot be bent: other leaf, other sibling or other tree does not open the root', () => {
    const k = screeningKey(ENTRIES[5]);
    const gap = tree.path(k - 1n);                              // leaf before the listed key: next == k, fails k < next
    assert.equal(pathRoot(gap), tree.root);
    assert.equal(gap.leaf.value <= k && (gap.leaf.next === 0n || k < gap.leaf.next), false);
    const bent = tree.path(k); bent.steps[0] = { ...bent.steps[0], sibling: bent.steps[0].sibling + 1n };
    assert.notEqual(pathRoot(bent), tree.root);
    const flipped = tree.path(k); flipped.steps[2] = { ...flipped.steps[2], is_right: !flipped.steps[2].is_right };
    assert.notEqual(pathRoot(flipped), tree.root);
    const without = new SanctionsTree(ENTRIES.filter((_, i) => i !== 5));
    assert.equal(proves(without, k), true);                     // a valid non-membership... in another tree
    assert.notEqual(without.root, tree.root);                   // ...whose root the provider never signed
  });

  it('root is deterministic, ignores order, case and duplicates; empty slots are never openable', () => {
    assert.equal(new SanctionsTree([...ENTRIES].reverse().map((h) => h.toUpperCase()).concat(ENTRIES[0])).root, tree.root);
    assert.deepEqual(sanctionsListRoot(ENTRIES), tree.rootBytes);
    const empty = new SanctionsTree([]);
    assert.ok(proves(empty, 12345n));                           // only the sentinel (0, none): everything is a non-member
    assert.equal(empty.path(12345n).leaf.next, 0n);
    assert.throws(() => new SanctionsTree(['zz']), /32-byte hex digests/);
  });

  it('screening key = first 16 bytes big-endian; root bytes are little-endian', () => {
    assert.equal(screeningKey('00'.repeat(15) + '01' + 'ff'.repeat(16)), 1n);
    assert.equal(screeningKey('ff'.repeat(16) + '00'.repeat(16)), (1n << 128n) - 1n);
    assert.deepEqual(Array.from(rootBytes(258n).subarray(0, 3)), [2, 1, 0]);
    assert.throws(() => screeningKey('ab'), /32-byte/);
  });

  it('the operator loads the snapshot by its signed root, and refuses entries that do not match it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
    const list = { list_root: tree.rootBytes } as SanctionsListWitness;
    assert.throws(() => sanctionsTreeFor('rel', list), /absolute/);
    assert.throws(() => sanctionsTreeFor(d, list), /not found/);
    const root = Buffer.from(tree.rootBytes).toString('hex');
    fs.writeFileSync(path.join(d, `${root}.txt`), ENTRIES.slice(1).join('\n'));
    assert.throws(() => sanctionsTreeFor(d, list), /do not produce the signed list_root/);
    fs.writeFileSync(path.join(d, `${root}.txt`), ENTRIES.join('\n') + '\n');
    assert.equal(sanctionsTreeFor(d, list).root, tree.root);
    assert.deepEqual(readEntries(' AB\n\ncd \n'), ['ab', 'cd']);
    assert.equal(treeForSignedRoot(ENTRIES, tree.rootBytes).root, tree.root);
  });

  // ── keyed screening (v12, LGPD): the circuit-side match is in test/travel-rule-gate.test.ts ──
  it('KEYED: a bare sha256 of a CPF is reversible; the keyed entry is not without the pepper', () => {
    // why v12 exists: a CPF has about 10^9 values, so anyone holding sha256(cpf) can search them all.
    const cpf = '12345678909';   // fictitious
    const bare = hx(cpf);
    const space = Array.from({ length: 1000 }, (_, i) => String(12345678000 + i));   // a slice of the search
    assert.equal(space.find((c) => hx(c) === bare), cpf, 'the bare hash gives the CPF back');
    const pepper = newPepper();
    const keyed = Buffer.from(screeningDigest(pepper, bare)).toString('hex');
    assert.equal(space.find((c) => hx(c) === keyed || Buffer.from(screeningDigest(newPepper(), hx(c))).toString('hex') === keyed), undefined, 'without the pepper the keyed entry tests no guess');
    assert.notEqual(keyed, bare);
  });

  it('KEYED: entries are deterministic per pepper, sorted and deduplicated; other pepper, other entries', () => {
    const p = new Uint8Array(32).fill(7);
    const e = keyedEntries(p, [...ENTRIES, ENTRIES[0].toUpperCase()]);
    assert.equal(e.length, ENTRIES.length);
    assert.deepEqual(e, [...e].sort());
    assert.deepEqual(keyedEntries(p, ENTRIES), e);
    assert.equal(e.some((x) => ENTRIES.includes(x)), false, 'no bare identifier hash in the snapshot');
    assert.notDeepEqual(keyedEntries(new Uint8Array(32).fill(8), ENTRIES), e);
    assert.deepEqual(pepperCommitment(p), pepperCommitment(new Uint8Array(32).fill(7)));
    assert.equal(newPepper().length, 32);
    assert.throws(() => screeningDigest(p, 'ab'), /identifier hash must be 32 bytes/);
  });

  it('KEYED: the operator reads the pepper from a restricted file and checks it against pepper_commit', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
    const pepper = newPepper();
    const list = { list_root: tree.rootBytes, pepper_commit: pepperCommitment(pepper) } as SanctionsListWitness;
    const root = Buffer.from(tree.rootBytes).toString('hex');
    const f = path.join(d, `${root}.pepper`);
    assert.throws(() => sanctionsPepperFor(d, list), /not found/);
    fs.writeFileSync(f, Buffer.from(pepper).toString('hex') + '\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.throws(() => sanctionsPepperFor(d, list), /no access for "other"/);
    fs.chmodSync(f, 0o600);
    assert.deepEqual(sanctionsPepperFor(d, list), pepper);
    assert.throws(() => sanctionsPepperFor(d, { ...list, pepper_commit: pepperCommitment(newPepper()) }), /does not open the signed pepper_commit/);
    assert.throws(() => parsePepper('00'.repeat(32), list.pepper_commit), /not zero/);
    assert.throws(() => parsePepper('xyz', list.pepper_commit), /32 bytes of hex/);
  });
});
