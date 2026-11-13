/**
 * Common verdict format v1 (docs/VERDICT-FORMAT.md): vectors in test/vectors/verdict-v1.json are
 * produced by running the compiled TravelRuleGate in the simulator on fixed, fictitious inputs, then
 * mapping its public ledger with scripts/lib/verdict.ts. Readers on other chains test against the
 * same vectors (verdict object, canonical JSON, digest). Regenerate with UPDATE_VECTORS=1.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import * as Gate from '../build/TravelRuleGate/contract/index.js';
import * as Passport from '../build/PsavPassport/contract/index.js';
import * as Registry from '../build/ComplianceRegistry/contract/index.js';
import { simAddress, contractRef, asDeployed, crossContract, SIM_BLOCK_HASH } from './helpers.js';
import { signSanctionsList, sanctionsListRoot, providerPublicKey } from '../scripts/lib/sanctions-list.js';
import { verdictFromLedger, verdictDigest, canonicalJson, checkVerdict, VERDICT_FORMAT } from '../scripts/lib/verdict.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors', 'verdict-v1.json');
const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const ZERO = new Uint8Array(32);
const CPK = '0'.repeat(64);
const T0 = 1_800_000_000;
const GATE = simAddress(0x6a7e), PASSPORT = simAddress(0x9a55), REGISTRY = simAddress(0x4e61);
const OWNER = b32('owner-secret-test-only'), APPROVER = b32('approver-secret-test-only'), SELF = b32('company:example-vasp');
const ATTESTED = b32('vasp:counterparty-A'), POLICY = b32('policy:travel-rule@1.0.0');
// Fixed (deterministic) provider key and list, so the vectors are reproducible.
const PROVIDER = new Uint8Array(32).fill(0xaa);
const PROVIDER_SK = 123456789n;
const LIST_ROOT = sanctionsListRoot(['11'.repeat(32), '22'.repeat(32)]);
const party = (n: string, doc: boolean, vasp: Uint8Array) => ({ name_hash: b32('name:' + n), account_hash: b32('acct:' + n), doc_hash: doc ? b32('doc:' + n) : ZERO, vasp_id: vasp, salt: b32('salt:' + n) });

/** Fixed cases: name, private inputs, release after evaluation. */
const CASES = [
  { name: 'pass-released', o: party('o1', true, b32('vasp:own')), b: party('b1', true, ATTESTED), amount: 250_000n, clear: true, release: true },
  { name: 'pass-not-released', o: party('o2', true, b32('vasp:own')), b: party('b2', true, ATTESTED), amount: 250_000n, clear: true, release: false },
  { name: 'fail-1-missing-party-info', o: party('o3', true, b32('vasp:own')), b: { ...party('b3', true, ATTESTED), account_hash: ZERO }, amount: 250_000n, clear: true, release: false },
  { name: 'fail-2-no-document-above-threshold', o: party('o4', false, b32('vasp:own')), b: party('b4', true, ATTESTED), amount: 250_000n, clear: true, release: false },
  { name: 'fail-3-counterparty-not-attested', o: party('o5', true, b32('vasp:own')), b: party('b5', true, b32('vasp:unknown')), amount: 250_000n, clear: true, release: false },
  { name: 'fail-4-sanctions-hit', o: party('o6', true, b32('vasp:own')), b: party('b6', true, ATTESTED), amount: 250_000n, clear: false, release: false },
];

async function simulate() {
  // Linked contracts: empty passport registry, registry with SELF attested (release needs it).
  const pw: any = Object.fromEntries(['owner_secret', 'rule_origins', 'rule_verdicts', 'partner_id', 'commit_salt', 'reviewer_sig_hash', 'evidence_hash', 'sponsor_secret'].map((k) => [k, () => { throw new Error('unused'); }]));
  const p = new Passport.Contract(pw);
  const pInit = (await p.initialState(createConstructorContext({}, CPK), Passport.pureCircuits.owner_commitment(b32('issuer')))).currentContractState;
  const rs = b32('reg');
  const r = new Registry.Contract({ owner_secret: (x: any) => [x.privateState, rs], score_salt: (x: any) => [x.privateState, b32('salt')] } as any);
  const rInit = (await r.initialState(createConstructorContext({}, CPK), Registry.pureCircuits.owner_commitment(rs))).currentContractState;
  const rState = (await r.circuits.attestCompliance(createCircuitContext({ circuitId: 'a', contractAddress: REGISTRY, coinPublicKeyOrZswapState: CPK, contractState: rInit.data, privateState: {}, time: T0 } as any), SELF, b32('did'), b32('cid'), 70n, b32('ctx'), 80n, b32('ev'))).context.callContext.currentQueryContext.state;
  const cross = crossContract({ [PASSPORT]: { state: asDeployed(pInit, pInit.data, 'PsavPassport'), module: Passport }, [REGISTRY]: { state: asDeployed(rInit, rState, 'ComplianceRegistry'), module: Registry } });
  const g = new Gate.Contract({
    originator_data: (x: any) => [x.privateState, x.privateState.o], beneficiary_data: (x: any) => [x.privateState, x.privateState.b],
    transfer_amount: (x: any) => [x.privateState, x.privateState.amount], sanctions_clear: (x: any) => [x.privateState, x.privateState.clear],
    owner_secret: (x: any) => [x.privateState, OWNER], approver_secret: (x: any) => [x.privateState, APPROVER],
    sanctions_list: (x: any) => [x.privateState, LIST],
  } as any);
  // The signature itself is randomized (Schnorr nonce) but never enters the verdict: only root, provider, valid_until.
  const LIST = signSanctionsList(Gate as any, PROVIDER_SK, { provider_id: PROVIDER, list_root: LIST_ROOT, issued_at: BigInt(T0 - 3600), valid_until: BigInt(T0 + 86_400) });
  let state: any = (await g.initialState(createConstructorContext({}, CPK), Gate.pureCircuits.owner_commitment(OWNER), 100_000n, contractRef(PASSPORT), contractRef(REGISTRY), SELF, Gate.pureCircuits.approver_commitment(APPROVER))).currentContractState;
  const run = async (ps: any, f: (c: any) => Promise<any>) => { state = (await f(createCircuitContext({ circuitId: 't', contractAddress: GATE, coinPublicKeyOrZswapState: CPK, contractState: state, privateState: ps, time: T0, parentBlockHash: SIM_BLOCK_HASH, crossContract: cross } as any))).context.callContext.currentQueryContext.state; };
  await run(CASES[0], (c) => g.circuits.registerSanctionsProvider(c, PROVIDER, providerPublicKey(PROVIDER_SK)));
  await run(CASES[0], (c) => g.circuits.attestVasp(c, ATTESTED));
  const out = [];
  for (const c of CASES) {
    const T = b32('transfer:' + c.name);
    await run(c, (x) => g.circuits.evaluateTransfer(x, T, POLICY));
    if (c.release) await run(c, (x) => g.circuits.releaseTransfer(x, T));
    const v = verdictFromLedger(Gate.ledger(state), T, { source_chain: 'midnight:simulator', source_contract: GATE });
    out.push({ name: c.name, verdict: v, canonical: canonicalJson(v), digest: verdictDigest(v) });
  }
  return out;
}

describe('verdict format v1', () => {
  it('vectors match the compiled gate run in the simulator', async () => {
    const got = await simulate();
    if (process.env.UPDATE_VECTORS === '1') fs.writeFileSync(VECTORS, JSON.stringify({ format: VERDICT_FORMAT, generated_by: 'test/verdict-format.test.ts (simulator, fictitious inputs)', vectors: got }, null, 2) + '\n');
    const want = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    assert.equal(want.format, VERDICT_FORMAT);
    assert.deepEqual(got, want.vectors);
  });

  it('every vector passes the format check, and digest = sha256(canonical JSON)', async () => {
    const { vectors } = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    assert.equal(vectors.length, 6);
    const { createHash } = await import('node:crypto');
    for (const x of vectors) {
      assert.deepEqual(checkVerdict(x.verdict), [], x.name);
      assert.equal(x.canonical, canonicalJson(x.verdict));
      assert.equal(x.digest, createHash('sha256').update(x.canonical).digest('hex'));
    }
    for (const x of vectors) assert.deepEqual(x.verdict.sanctions, { list_root: Buffer.from(LIST_ROOT).toString('hex'), provider_id: 'aa'.repeat(32), valid_until: T0 + 86_400 });
    assert.deepEqual(vectors.map((x: any) => [x.verdict.verdict, x.verdict.released, x.verdict.reason.code]),
      [['PASS', true, 0], ['PASS', false, 0], ['FAIL', false, 1], ['FAIL', false, 2], ['FAIL', false, 3], ['FAIL', false, 4]]);
  });

  it('format check rejects inconsistent verdicts', async () => {
    const { vectors } = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    const v = vectors[0].verdict;
    assert.ok(checkVerdict({ ...v, verdict: 'FAIL' }).some((e) => /PASS has reason 0/.test(e)));
    assert.ok(checkVerdict({ ...vectors[2].verdict, released: true }).some((e) => /only a PASS/.test(e)));
    assert.ok(checkVerdict({ ...v, reason: { code: 3, label: 'none' } }).some((e) => /matching label/.test(e)));
    assert.ok(checkVerdict({ ...v, tx: 'ab' }).some((e) => /both set or both null/.test(e)));
    assert.ok(checkVerdict({ ...v, policy_hash: 'XY' }).some((e) => /policy_hash/.test(e)));
    assert.ok(checkVerdict({ ...v, source_chain: 'midnight' }).some((e) => /source_chain/.test(e)));
    assert.deepEqual(checkVerdict({ ...v, block: { height: 12, hash: 'ab'.repeat(32) }, tx: 'cd'.repeat(32) }), []);
  });

  it('an unknown transfer has no verdict', async () => {
    const L = { status: { member: () => false } };
    assert.throws(() => verdictFromLedger(L, b32('nope'), { source_chain: 'midnight:simulator', source_contract: GATE }), /has no verdict/);
  });
});
