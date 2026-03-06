import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../compact/build/compliance-registry/contract/index.js';

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

describe('ComplianceRegistry', () => {
  it('should register an attestation and update ledger state', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.registerAttestation(
      ctx,
      padTo32Bytes('test_company_001'),
      padTo32Bytes('did:midnight:agent:01'),
      padTo32Bytes('bafybeigdyrzt5sfp7udm7hu76'),
      85n,
    );

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.attestation_scores.isEmpty(), false);
    assert.equal(postLedger.attestation_score, 85n);
  });

  it('should reject score > 100', () => {
    const { contract, ctx } = setup();

    assert.throws(
      () => {
        contract.circuits.registerAttestation(
          ctx,
          padTo32Bytes('company'),
          padTo32Bytes('did'),
          padTo32Bytes('cid'),
          101n,
        );
      },
      /Invalid compliance score/,
    );
  });

  it('should accept boundary score of 100', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.registerAttestation(
      ctx, padTo32Bytes('company'), padTo32Bytes('did'), padTo32Bytes('cid'), 100n,
    );

    const postLedger = ledger(context.currentQueryContext.state);
    assert.equal(postLedger.attestation_score, 100n);
  });

  it('should return score via getComplianceStatus', () => {
    const { contract, ctx } = setup();

    const { context } = contract.circuits.registerAttestation(
      ctx, padTo32Bytes('company'), padTo32Bytes('did'), padTo32Bytes('cid'), 92n,
    );

    const queryResult = contract.circuits.getComplianceStatus(context, padTo32Bytes('company'));
    assert.equal(queryResult.result, 92n);
  });
});
