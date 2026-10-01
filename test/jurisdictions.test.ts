/**
 * Jurisdiction-code parity: the single ComplianceRegistry.attestUseCase circuit delivers
 * ALL DPO2U jurisdiction frameworks (Stellar/Solana parity) through one audited contract.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/ComplianceRegistry/contract/index.js';
import { JURISDICTION_CODES, useCaseId, sha256Bytes32 } from '../src/jurisdictions.js';

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

describe('Jurisdiction-code parity', () => {
  it('covers the full canonical set (25 codes)', () => {
    assert.equal(JURISDICTION_CODES.length, 25);
    assert.ok(JURISDICTION_CODES.includes('LGPD'));
    assert.ok(JURISDICTION_CODES.includes('MICAR-CASP'));
    assert.ok(JURISDICTION_CODES.includes('ARGENTINA'));
  });

  it('maps every code to a distinct 32-byte use_case_id', () => {
    const ids = JURISDICTION_CODES.map((c) => useCaseId(c));
    ids.forEach((id) => assert.equal(id.length, 32));
    const unique = new Set(ids.map((b) => Buffer.from(b).toString('hex')));
    assert.equal(unique.size, JURISDICTION_CODES.length);
  });

  it('derives use_case_id deterministically', () => {
    assert.deepEqual(useCaseId('LGPD'), useCaseId('LGPD'));
    assert.notDeepEqual(useCaseId('LGPD'), useCaseId('GDPR'));
  });

  it('attestUseCase seals a PASS verdict for EVERY jurisdiction through one contract', () => {
    const { contract, ctx } = setup();
    let context = ctx;
    for (const code of JURISDICTION_CODES) {
      const evidence = sha256Bytes32(`evidence:${code}:2026`);
      const metadata = sha256Bytes32(`metadata:${code}`);
      const r = contract.circuits.attestUseCase(context, useCaseId(code), 1n, evidence, metadata);
      context = r.context;
      // read the verdict back by its evidence_hash key
      assert.equal(contract.circuits.getUseCaseVerdict(context, evidence).result, 1n);
    }
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.usecase_attestation_count, BigInt(JURISDICTION_CODES.length));
  });
});
