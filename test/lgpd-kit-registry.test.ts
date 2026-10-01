/**
 * LgpdKitRegistry — anti-fraud registry for generated LGPD documents (DPIA/policy hashes).
 * API unchanged from canonical (pragma bumped 0.19→0.21); import path updated.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/LgpdKitRegistry/contract/index.js';

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

describe('LgpdKitRegistry', () => {
  it('registers an LGPD kit with hashes + score', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.registerLgpdKit(
      ctx,
      padTo32Bytes('cnpj_12345678000199'),
      padTo32Bytes('bafybeig...dpiadoc'),
      padTo32Bytes('bafybeig...policydoc'),
      95n,
      padTo32Bytes('did:midnight:agent:02'),
    );
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.kit_dpia_hashes.isEmpty(), false);
    assert.equal(L.kit_policy_hashes.isEmpty(), false);
    assert.equal(L.kit_privacy_scores.isEmpty(), false);
    assert.equal(L.kit_auditor_dids.isEmpty(), false);
  });

  it('rejects score > 100', () => {
    const { contract, ctx } = setup();
    assert.throws(
      () => contract.circuits.registerLgpdKit(
        ctx, padTo32Bytes('c'), padTo32Bytes('d'), padTo32Bytes('p'), 101n, padTo32Bytes('a'),
      ),
      /Invalid compliance score/,
    );
  });

  it('reads back the company privacy score', () => {
    const { contract, ctx } = setup();
    const company = padTo32Bytes('score_test_company');
    const { context } = contract.circuits.registerLgpdKit(
      ctx, company, padTo32Bytes('d'), padTo32Bytes('p'), 92n, padTo32Bytes('a'),
    );
    assert.equal(contract.circuits.getCompanyPrivacyScore(context, company).result, 92n);
  });

  it('returns 0 for an unknown company', () => {
    const { contract, ctx } = setup();
    assert.equal(contract.circuits.getCompanyPrivacyScore(ctx, padTo32Bytes('unknown')).result, 0n);
  });
});
