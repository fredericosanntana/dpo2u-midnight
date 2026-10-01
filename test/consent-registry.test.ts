/**
 * ConsentRegistry — LGPD/GDPR consent grant/revoke/update (no PII on-chain).
 * Purposes bitmask: 0x01 essential, 0x02 analytics, 0x04 marketing, 0x08 sharing, 0x10 profiling.
 * Status: 0 none, 1 active, 2 revoked.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../build/ConsentRegistry/contract/index.js';

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

const SUBJECT = padTo32Bytes('keccak256(email):acme-user-1');

describe('ConsentRegistry (LGPD Art. 7-8)', () => {
  it('grants consent: status active, purposes + policy version sealed', () => {
    const { contract, ctx } = setup();
    const { context } = contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const L = ledger(context.currentQueryContext.state);
    assert.equal(L.consent_status.lookup(SUBJECT), 1n);
    assert.equal(L.consent_purposes.lookup(SUBJECT), 0x07n);
    assert.equal(L.consent_policy_version.lookup(SUBJECT), 1n);
    assert.equal(L.total_consents_granted, 1n);
  });

  it('rejects grant with no purposes', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.grantConsent(ctx, SUBJECT, 0n, 1n), /Must grant at least one purpose/);
  });

  it('rejects grant with no policy version', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.grantConsent(ctx, SUBJECT, 0x01n, 0n), /Policy version must be specified/);
  });

  it('revokes consent: status=2, purposes cleared, revocation counted (Art. 8 §5)', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const { context: c3 } = contract.circuits.revokeConsent(c2, SUBJECT);
    const L = ledger(c3.currentQueryContext.state);
    assert.equal(L.consent_status.lookup(SUBJECT), 2n);
    assert.equal(L.consent_purposes.lookup(SUBJECT), 0n);
    assert.equal(L.total_revocations, 1n);
  });

  it('rejects revoking a subject with no record', () => {
    const { contract, ctx } = setup();
    assert.throws(() => contract.circuits.revokeConsent(ctx, SUBJECT), /No consent record found/);
  });

  it('updates purposes without full revocation', () => {
    const { contract, ctx } = setup();
    const { context: c2 } = contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const { context: c3 } = contract.circuits.updateConsentPurposes(c2, SUBJECT, 0x01n, 2n);
    assert.equal(contract.circuits.getConsentPurposes(c3, SUBJECT).result, 0x01n);
    assert.equal(contract.circuits.getConsentStatus(c3, SUBJECT).result, 1n);
  });

  it('returns 0 status for an unknown subject', () => {
    const { contract, ctx } = setup();
    assert.equal(contract.circuits.getConsentStatus(ctx, padTo32Bytes('nobody')).result, 0n);
  });
});
