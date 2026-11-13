/**
 * ConsentRegistry — LGPD/GDPR consent grant/revoke/update (no PII on-chain).
 * Purposes bitmask: 0x01 essential, 0x02 analytics, 0x04 marketing, 0x08 sharing, 0x10 profiling.
 * Status: 0 none, 1 active, 2 revoked.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Contract, ledger, pureCircuits } from '../build/ConsentRegistry/contract/index.js';
import * as DSR from '../build/DataSubjectRights/contract/index.js';
import { createHash } from 'node:crypto';
import { setupOwned, asStranger, b32, NOT_OWNER } from './helpers.js';

function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

function setup() {
  return setupOwned(Contract, pureCircuits);
}

const SUBJECT = padTo32Bytes('keccak256(email):acme-user-1');

describe('ConsentRegistry (LGPD Art. 7-8)', () => {
  it('grants consent: status active, purposes + policy version sealed', async () => {
    const { contract, ctx } = await setup();
    const { context } = await contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const L = ledger(context.callContext.currentQueryContext.state);
    assert.equal(L.consent_status.lookup(SUBJECT), 1n);
    assert.equal(L.consent_purposes.lookup(SUBJECT), 0x07n);
    assert.equal(L.consent_policy_version.lookup(SUBJECT), 1n);
    assert.equal(L.total_consents_granted, 1n);
  });

  it('rejects grant with no purposes', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.grantConsent(ctx, SUBJECT, 0n, 1n), /Must grant at least one purpose/);
  });

  it('rejects grant with no policy version', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.grantConsent(ctx, SUBJECT, 0x01n, 0n), /Policy version must be specified/);
  });

  it('revokes consent: status=2, purposes cleared, revocation counted (Art. 8 §5)', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const { context: c3 } = await contract.circuits.revokeConsent(c2, SUBJECT);
    const L = ledger(c3.callContext.currentQueryContext.state);
    assert.equal(L.consent_status.lookup(SUBJECT), 2n);
    assert.equal(L.consent_purposes.lookup(SUBJECT), 0n);
    assert.equal(L.total_revocations, 1n);
  });

  it('rejects revoking a subject with no record', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.revokeConsent(ctx, SUBJECT), /No consent record found/);
  });

  it('updates purposes without full revocation', async () => {
    const { contract, ctx } = await setup();
    const { context: c2 } = await contract.circuits.grantConsent(ctx, SUBJECT, 0x07n, 1n);
    const { context: c3 } = await contract.circuits.updateConsentPurposes(c2, SUBJECT, 0x01n, 2n);
    assert.equal((await contract.circuits.getConsentPurposes(c3, SUBJECT)).result, 0x01n);
    assert.equal((await contract.circuits.getConsentStatus(c3, SUBJECT)).result, 1n);
  });

  it('returns 0 status for an unknown subject', async () => {
    const { contract, ctx } = await setup();
    assert.equal((await contract.circuits.getConsentStatus(ctx, padTo32Bytes('nobody'))).result, 0n);
  });
});

describe('ConsentRegistry access control', () => {
  it('rejects a caller that does not hold the owner secret', async () => {
    const { contract, ctx } = await setup();
    await assert.rejects(() => contract.circuits.grantConsent(asStranger(ctx), b32('subject'), 0x01n, 1n), NOT_OWNER);
  });
});

describe('ConsentRegistry subject_key (salted subject id)', () => {
  const idHash = (email: string) => new Uint8Array(createHash('sha256').update(email.trim().toLowerCase()).digest());
  const SALT_A = b32('controller-salt-A');
  const SALT_B = b32('controller-salt-B');

  it('is deterministic for the same identifier and salt', () => {
    assert.deepEqual(pureCircuits.subject_key(idHash('Titular@Example.com'), SALT_A), pureCircuits.subject_key(idHash('titular@example.com'), SALT_A));
  });

  it('changes with the salt and differs from the bare identifier hash', () => {
    const h = idHash('titular@example.com');
    const a = pureCircuits.subject_key(h, SALT_A);
    assert.notDeepEqual(a, pureCircuits.subject_key(h, SALT_B));
    assert.notDeepEqual(a, h);
    assert.notDeepEqual(a, pureCircuits.subject_key(idHash('other@example.com'), SALT_A));
  });

  it('matches DataSubjectRights.subject_key, so both contracts index the same subject', () => {
    const h = idHash('titular@example.com');
    assert.deepEqual(pureCircuits.subject_key(h, SALT_A), DSR.pureCircuits.subject_key(h, SALT_A));
  });

  it('works as the subject_id of a consent record', async () => {
    const { contract, ctx } = await setup();
    const key = pureCircuits.subject_key(idHash('titular@example.com'), SALT_A);
    const { context } = await contract.circuits.grantConsent(ctx, key, 0x01n, 1n);
    assert.equal(ledger(context.callContext.currentQueryContext.state).consent_status.lookup(key), 1n);
  });
});
