/**
 * LgpdKitRegistry — anti-fraud registry for generated LGPD documents (DPIA/policy hashes).
 * API unchanged from canonical (pragma bumped 0.19→0.21); import path updated.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/LgpdKitRegistry/contract/index.js';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

describe('LgpdKitRegistry', () => {
  it('registers an LGPD kit with hashes + score', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.registerLgpdKit(
      ctx,
      padTo32Bytes('cnpj_12345678000199'),
      padTo32Bytes('bafybeig...dpiadoc'),
      padTo32Bytes('bafybeig...policydoc'),
      95n,
      padTo32Bytes('did:midnight:agent:02'),
    );
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.kit_dpia_hashes.isEmpty(), false);
    assert.equal(L.kit_policy_hashes.isEmpty(), false);
    assert.equal(L.kit_privacy_scores.isEmpty(), false);
    assert.equal(L.kit_auditor_dids.isEmpty(), false);
  });

  it('rejects score > 100', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(
      () => contract.circuits.registerLgpdKit(
        ctx, padTo32Bytes('c'), padTo32Bytes('d'), padTo32Bytes('p'), 101n, padTo32Bytes('a'),
      ),
      /Invalid compliance score/,
    );
  });

  it('reads back the company privacy score', async () => {
    const { contract, ctx } = await setup();
    const company = padTo32Bytes('score_test_company');
    const { context } = await contract.circuits.registerLgpdKit(
      ctx, company, padTo32Bytes('d'), padTo32Bytes('p'), 92n, padTo32Bytes('a'),
    );
    assert.equal((await contract.circuits.getCompanyPrivacyScore(context, company)).result, 92n);
  });

  it('returns 0 for an unknown company', async () => {
    const { contract, ctx } = await setup();
    assert.equal((await contract.circuits.getCompanyPrivacyScore(ctx, padTo32Bytes('unknown'))).result, 0n);
  });
});

describe('LgpdKitRegistry access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.registerLgpdKit(asStranger(ctx), b32('co'), b32('dpia'), b32('pol'), 90n, b32('aud')), NOT_OWNER);
  });
});
