/**
 * ComplianceRegistry — score-private / proof-public + anti-replay.
 *
 * Rewritten for the consolidated contract (was score-public registerAttestation /
 * attestation_scores / getComplianceStatus). The new contract NEVER stores the score:
 * it proves `score >= threshold` and seals only verdict + public threshold + anti-replay
 * context. Ported from the Stellar ZK reference (zk-verifier CBOOYCOU…).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/ComplianceRegistry/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER, publicStateHex, SCORE_SALT, withPrivateState, OWNER_SECRET } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

const COMPANY = padTo32Bytes('acme-corp-001');
const DID = padTo32Bytes('did:midnight:agent:01');
const CID = padTo32Bytes('bafybeigdyrzt5sfp7udm7hu76');
const CTX_A = padTo32Bytes('ctx:acme||LGPD||nonce-0001');
const CTX_B = padTo32Bytes('ctx:acme||LGPD||nonce-0002');
const EVIDENCE = padTo32Bytes('sha256:evidence-pack-acme-0001');

describe('ComplianceRegistry (score-private / proof-public)', () => {
  it('valid attestation (score>=threshold) seals verdict+threshold+context', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n, EVIDENCE);
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.attestation_verdicts.lookup(COMPANY), 1n);
    assert.equal(L.attestation_thresholds.lookup(COMPANY), 70n);
    assert.equal(L.used_contexts.member(CTX_A), true);
    assert.equal(L.attestation_count, 1n);
  });

  it('rejects score < threshold (no proof for a false statement)', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(
      () => contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 50n, EVIDENCE),
      /Score below threshold/,
    );
  });

  it('rejects a reused context (anti-replay), accepts a fresh one', async () => {
    const { contract, ctx } = await setup();
    const r1 = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 90n, EVIDENCE);
    await assert.rejects(
      () => contract.circuits.attestCompliance(
        r1.context, padTo32Bytes('other-corp'), DID, CID, 60n, CTX_A, 95n, EVIDENCE,
      ),
      /Replay: context already used/,
    );
    const r2 = await contract.circuits.attestCompliance(
      r1.context, padTo32Bytes('other-corp'), DID, CID, 60n, CTX_B, 95n, EVIDENCE,
    );
    assert.equal(ledger(r2.context.callContext.currentQueryContext.state).attestation_count, 2n);
  });

  it('rejects score > 100 (hygiene)', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(
      () => contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 101n, EVIDENCE),
      /Invalid compliance score/,
    );
  });

  it('NEVER exposes the score — there is no attestation_scores ledger', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 0n, CTX_A, 100n, EVIDENCE);
    const L = ledger(context.callContext.currentQueryContext.state) as Record<string, unknown>;
    assert.equal('attestation_scores' in L, false);
    assert.equal('attestation_verdicts' in L, true);
    assert.equal('attestation_contexts' in L, true);
  });

  it('hasAttestation reads back the sealed verdict; 0 for an unknown company', async () => {
    const { contract, ctx } = await setup();
    assert.equal((await contract.circuits.hasAttestation(ctx, COMPANY)).result, 0n);
    const { context } = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n, EVIDENCE);
    assert.equal((await contract.circuits.hasAttestation(context, COMPANY)).result, 1n);
  });

  it('records evidence_hash and a score commitment that opens with (score, salt) only', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n, EVIDENCE);
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.deepEqual(L.attestation_evidence.lookup(COMPANY), EVIDENCE);
    const commit = L.attestation_score_commit.lookup(COMPANY);
    assert.deepEqual(commit, pureCircuits.score_commitment(85n, SCORE_SALT));
    assert.notDeepEqual(commit, pureCircuits.score_commitment(84n, SCORE_SALT), 'another score does not open it');
    assert.notDeepEqual(commit, pureCircuits.score_commitment(85n, b32('other-salt')), 'the salt is needed to open it');
  });

  it('the score commitment is hiding: same score, different salt -> different commitment', async () => {
    const { contract, ctx } = await setup();
    const a = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n, EVIDENCE);
    const other = withPrivateState(a.context, { ownerSecret: OWNER_SECRET, scoreSalt: b32('salt-2') });
    const b = await contract.circuits.attestCompliance(other, b32('co-2'), DID, CID, 70n, CTX_B, 85n, EVIDENCE);
    const L = ledger(b.context.callContext.currentQueryContext.state);
    assert.notDeepEqual(L.attestation_score_commit.lookup(COMPANY), L.attestation_score_commit.lookup(b32('co-2')));
  });

  it('PRIVACY: the score is not in the public state (scan of every ledger value)', async () => {
    const { contract, ctx } = await setup();
    const SCORE = 0x5bn; // 91: a byte value that appears nowhere else in this attestation
    const { context } = await contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, SCORE, EVIDENCE);
    const blob = publicStateHex(context.callContext.currentQueryContext.state);
    const L = ledger(context.callContext.currentQueryContext.state);
    // control: the public threshold (0x46) and the commitment are visible to the scan
    assert.ok(blob.split('|').includes('46'), 'scan control failed: threshold not found');
    assert.ok(blob.includes(Buffer.from(L.attestation_score_commit.lookup(COMPANY)).toString('hex')));
    assert.ok(!blob.split('|').includes('5b'), 'score value stored as a public ledger value');
    assert.ok(!blob.includes(Buffer.from(SCORE_SALT).toString('hex')), 'score salt leaked');
  });

  it('attestUseCase seals verdict by evidence_hash; getUseCaseVerdict reads it back', async () => {
    const { contract, ctx } = await setup();
    const evh = padTo32Bytes('evidence-hash-001');
    const { context } = await contract.circuits.attestUseCase(
      ctx, padTo32Bytes('lgpd_compliance_v1'), 1n, evh, padTo32Bytes('metadata-hash-001'),
    );
    assert.equal((await contract.circuits.getUseCaseVerdict(context, evh)).result, 1n);
    assert.equal(ledger(context.callContext.currentQueryContext.state).usecase_attestation_count, 1n);
  });

  it('attestUseCase rejects verdict > 2', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(
      () => contract.circuits.attestUseCase(ctx, padTo32Bytes('x'), 3n, padTo32Bytes('e'), padTo32Bytes('m')),
      /Invalid verdict/,
    );
  });
});

describe('ComplianceRegistry access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.attestUseCase(asStranger(ctx), b32('uc'), 1n, b32('evidence'), b32('meta')), NOT_OWNER);
  });

  it('a stranger cannot overwrite an owner verdict (FAIL -> PASS)', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.attestUseCase(ctx, b32('uc'), 0n, b32('evidence'), b32('meta'));
    await assert.rejects(() => contract.circuits.attestUseCase(asStranger(context), b32('uc'), 1n, b32('evidence'), b32('meta')), NOT_OWNER);
  });

  it('a stranger cannot self-attest a score or meter sponsored usage', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.attestCompliance(asStranger(ctx), b32('co'), b32('did'), b32('cid'), 70n, b32('ctx-1'), 100n, EVIDENCE), NOT_OWNER);
    await assert.rejects(() => contract.circuits.recordSponsoredAttestation(asStranger(ctx), b32('did'), b32('sponsor')), NOT_OWNER);
  });
});
