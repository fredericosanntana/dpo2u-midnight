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
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/ComplianceRegistry/contract/index.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  const contract = new Contract({});
  const coinPublicKey = '0'.repeat(64) as unknown as string;
  const { currentContractState, currentPrivateState } = contract.initialState({
    initialZswapLocalState: { coinPublicKey },
    initialPrivateState: new Map(),
  });
  const ctx = createCircuitContext(
    dummyContractAddress(),
    coinPublicKey,
    currentContractState.data,
    currentPrivateState ?? new Map(),
  );
  return { contract, ctx };
}

const COMPANY = padTo32Bytes('acme-corp-001');
const DID = padTo32Bytes('did:midnight:agent:01');
const CID = padTo32Bytes('bafybeigdyrzt5sfp7udm7hu76');
const CTX_A = padTo32Bytes('ctx:acme||LGPD||nonce-0001');
const CTX_B = padTo32Bytes('ctx:acme||LGPD||nonce-0002');

describe('ComplianceRegistry (score-private / proof-public)', () => {
  it('valid attestation (score>=threshold) seals verdict+threshold+context', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n);
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.attestation_verdicts.lookup(COMPANY), 1n);
    assert.equal(L.attestation_thresholds.lookup(COMPANY), 70n);
    assert.equal(L.used_contexts.member(CTX_A), true);
    assert.equal(L.attestation_count, 1n);
  });

  it('rejects score < threshold (no proof for a false statement)', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 50n),
      /Score below threshold/,
    );
  });

  it('rejects a reused context (anti-replay), accepts a fresh one', () => {
    const { contract, ctx } = setup();
    const r1 = contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 90n);
    assert.throws(
      () => contract.circuits.attestCompliance(
        r1.context, padTo32Bytes('other-corp'), DID, CID, 60n, CTX_A, 95n,
      ),
      /Replay: context already used/,
    );
    const r2 = contract.circuits.attestCompliance(
      r1.context, padTo32Bytes('other-corp'), DID, CID, 60n, CTX_B, 95n,
    );
    assert.equal(ledger(r2.context.currentQueryContext.state).attestation_count, 2n);
  });

  it('rejects score > 100 (hygiene)', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 101n),
      /Invalid compliance score/,
    );
  });

  it('NEVER exposes the score — there is no attestation_scores ledger', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 0n, CTX_A, 100n);
    const L = ledger(context.currentQueryContext.state) as Record<string, unknown>;
    assert.equal('attestation_scores' in L, false);
    assert.equal('attestation_verdicts' in L, true);
    assert.equal('attestation_contexts' in L, true);
  });

  it('hasAttestation reads back the sealed verdict', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.attestCompliance(ctx, COMPANY, DID, CID, 70n, CTX_A, 85n);
    assert.equal(contract.circuits.hasAttestation(context, COMPANY).result, 1n);
  });

  it('attestUseCase seals verdict by evidence_hash; getUseCaseVerdict reads it back', () => {
    const { contract, ctx } = setup();
    const evh = padTo32Bytes('evidence-hash-001');
    const { context } = contract.circuits.attestUseCase(
      ctx, padTo32Bytes('lgpd_compliance_v1'), 1n, evh, padTo32Bytes('metadata-hash-001'),
    );
    assert.equal(contract.circuits.getUseCaseVerdict(context, evh).result, 1n);
    assert.equal(ledger(context.currentQueryContext.state).usecase_attestation_count, 1n);
  });

  it('attestUseCase rejects verdict > 2', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.attestUseCase(ctx, padTo32Bytes('x'), 3n, padTo32Bytes('e'), padTo32Bytes('m')),
      /Invalid verdict/,
    );
  });
});
