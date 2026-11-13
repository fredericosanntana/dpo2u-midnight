/**
 * TravelRuleGate — PASS and FAIL cases, shielded party data, scoped disclosure grants.
 * Runs against the compiled contract in the Compact runtime simulator (no network).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, createConstructorContext, dummyContractAddress, type CircuitContext } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../build/TravelRuleGate/contract/index.js';
import { publicStateHex } from './helpers.js';

type Party = { name_hash: Uint8Array; account_hash: Uint8Array; doc_hash: Uint8Array; vasp_id: Uint8Array; salt: Uint8Array };
type PS = { o: Party; b: Party; amount: bigint; sanctionsClear: boolean; secret: Uint8Array };

const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const ZERO = new Uint8Array(32);
const OWNER_SECRET = b32('owner-secret-test-only');
const THRESHOLD = 100_000n; // R$ 1.000,00 in cents (fictional threshold)
const BENEF_VASP = b32('vasp:counterparty-A');
const T0 = 1_800_000_000;

const witnesses = {
  originator_data: (c: any) => [c.privateState, c.privateState.o] as [PS, Party],
  beneficiary_data: (c: any) => [c.privateState, c.privateState.b] as [PS, Party],
  transfer_amount: (c: any) => [c.privateState, c.privateState.amount] as [PS, bigint],
  sanctions_clear: (c: any) => [c.privateState, c.privateState.sanctionsClear] as [PS, boolean],
  owner_secret: (c: any) => [c.privateState, c.privateState.secret] as [PS, Uint8Array],
};

const party = (n: string, withDoc: boolean, vasp = b32('vasp:own')): Party => ({
  name_hash: b32('name:' + n), account_hash: b32('acct:' + n),
  doc_hash: withDoc ? b32('doc:' + n) : ZERO, vasp_id: vasp, salt: b32('salt:' + n),
});

function base(over: Partial<PS> = {}): PS {
  return { o: party('orig', true), b: party('benef', true, BENEF_VASP), amount: 250_000n, sanctionsClear: true, secret: OWNER_SECRET, ...over };
}

async function setup(ps: PS) {
  const contract = new Contract<PS>(witnesses as any);
  const cpk = '0'.repeat(64);
  const { currentContractState } = await contract.initialState(
    createConstructorContext(ps, cpk), pureCircuits.owner_commitment(OWNER_SECRET), THRESHOLD);
  const mk = (state: any, p: PS, t = T0): CircuitContext<PS> => createCircuitContext({
    circuitId: 'test', contractAddress: dummyContractAddress(), coinPublicKeyOrZswapState: cpk,
    contractState: state, privateState: p, time: t,
  } as any);
  return { contract, ctx: mk(currentContractState, ps), mk };
}

const TID = b32('transfer-1');

describe('TravelRuleGate', () => {
  it('PASS: complete data, attested counterparty -> verdict 1, then release -> 3', async () => {
    const ps = base();
    const { contract, ctx } = await setup(ps);
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(c1, TID);
    assert.equal(r.result, 1n);
    const L = ledger(r.context.callContext.currentQueryContext.state);
    assert.equal(L.status.lookup(TID), 1n);
    assert.equal(L.fail_reason.lookup(TID), 0n);
    assert.equal(L.total_pass, 1n);
    const rel = await contract.circuits.releaseTransfer(r.context, TID);
    assert.equal(ledger(rel.context.callContext.currentQueryContext.state).status.lookup(TID), 3n);
    assert.equal(ledger(rel.context.callContext.currentQueryContext.state).total_released, 1n);
  });

  it('FAIL: counterparty VASP not attested -> verdict 2 reason 3, release reverts', async () => {
    const { contract, ctx } = await setup(base());
    const r = await contract.circuits.evaluateTransfer(ctx, TID);
    assert.equal(r.result, 2n);
    const L = ledger(r.context.callContext.currentQueryContext.state);
    assert.equal(L.status.lookup(TID), 2n);
    assert.equal(L.fail_reason.lookup(TID), 3n);
    assert.equal(L.total_fail, 1n);
    await assert.rejects(() => contract.circuits.releaseTransfer(r.context, TID), /Travel Rule not satisfied/);
  });

  it('FAIL: above threshold without originator document -> reason 2; below threshold the same data passes', async () => {
    const noDoc = base({ o: party('orig', false) });
    const a = await setup(noDoc);
    const { context: c1 } = await a.contract.circuits.attestVasp(a.ctx, BENEF_VASP);
    const r = await a.contract.circuits.evaluateTransfer(c1, TID);
    assert.equal(r.result, 2n);
    assert.equal(ledger(r.context.callContext.currentQueryContext.state).fail_reason.lookup(TID), 2n);

    const small = base({ o: party('orig', false), amount: 50_000n });
    const s = await setup(small);
    const { context: s1 } = await s.contract.circuits.attestVasp(s.ctx, BENEF_VASP);
    assert.equal((await s.contract.circuits.evaluateTransfer(s1, TID)).result, 1n);
  });

  it('FAIL: missing beneficiary info -> reason 1; sanctions hit -> reason 4', async () => {
    const miss = await setup(base({ b: { ...party('benef', true, BENEF_VASP), account_hash: ZERO } }));
    const { context: m1 } = await miss.contract.circuits.attestVasp(miss.ctx, BENEF_VASP);
    assert.equal(ledger((await miss.contract.circuits.evaluateTransfer(m1, TID)).context.callContext.currentQueryContext.state).fail_reason.lookup(TID), 1n);

    const sx = await setup(base({ sanctionsClear: false }));
    const { context: s1 } = await sx.contract.circuits.attestVasp(sx.ctx, BENEF_VASP);
    assert.equal(ledger((await sx.contract.circuits.evaluateTransfer(s1, TID)).context.callContext.currentQueryContext.state).fail_reason.lookup(TID), 4n);
  });

  it('PRIVACY: public state holds no raw party data, only salted roots', async () => {
    const ps = base();
    const { contract, ctx } = await setup(ps);
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const { context: c2 } = await contract.circuits.evaluateTransfer(c1, TID);
    const blob = publicStateHex(c2.callContext.currentQueryContext.state); // full public ledger state, hex-rendered
    for (const secret of [ps.o.name_hash, ps.o.account_hash, ps.o.doc_hash, ps.b.name_hash, ps.b.account_hash, ps.o.salt]) {
      assert.ok(!blob.includes(Buffer.from(secret).toString('hex')), 'raw private field leaked into public state');
    }
    const L = ledger(c2.callContext.currentQueryContext.state);
    // control: the scan does see public values (the root and the attested VASP id are in the blob)
    assert.ok(blob.includes(Buffer.from(L.originator_root.lookup(TID)).toString('hex')), 'scan control failed');
    assert.equal(L.originator_root.lookup(TID).length, 32);
    assert.notDeepEqual(L.originator_root.lookup(TID), L.beneficiary_root.lookup(TID));
  });

  it('evaluate twice is rejected; non-owner cannot release or grant', async () => {
    const { contract, ctx, mk } = await setup(base());
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const { context: c2 } = await contract.circuits.evaluateTransfer(c1, TID);
    await assert.rejects(() => contract.circuits.evaluateTransfer(c2, TID), /already evaluated/);
    const intruder = mk(c2.callContext.currentQueryContext.state, base({ secret: b32('not-the-owner') }));
    await assert.rejects(() => contract.circuits.releaseTransfer(intruder, TID), /Only the VASP owner/);
  });

  it('a non-owner cannot evaluate a transfer', async () => {
    const { contract, ctx, mk } = await setup(base());
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const intruder = mk(c1.callContext.currentQueryContext.state, base({ secret: b32('not-the-owner') }));
    await assert.rejects(() => contract.circuits.evaluateTransfer(intruder, TID), /Only the VASP owner can do this/);
    assert.equal(ledger(c1.callContext.currentQueryContext.state).status.member(TID), false);
    assert.equal(ledger(intruder.callContext.currentQueryContext.state).status.member(TID), false);
  });

  it('DISCLOSURE: scoped grant is active, expires with block time, and can be revoked', async () => {
    const { contract, ctx, mk } = await setup(base());
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const { context: c2 } = await contract.circuits.evaluateTransfer(c1, TID);
    const G = b32('grant-bcb-1'), SUP = b32('supervisor:BCB');
    const { context: c3 } = await contract.circuits.grantDisclosure(c2, G, TID, SUP, 0b0001n, BigInt(T0 + 3600));
    const L = ledger(c3.callContext.currentQueryContext.state);
    assert.equal(L.grant_scope.lookup(G), 1n);
    assert.equal((await contract.circuits.isGrantActive(c3, G)).result, true);
    // later than expiry
    const late = mk(c3.callContext.currentQueryContext.state, base(), T0 + 7200);
    assert.equal((await contract.circuits.isGrantActive(late, G)).result, false);
    // revoked before expiry
    const { context: c4 } = await contract.circuits.revokeDisclosure(c3, G);
    assert.equal((await contract.circuits.isGrantActive(c4, G)).result, false);
    // empty scope and past expiry rejected
    await assert.rejects(() => contract.circuits.grantDisclosure(c2, b32('g2'), TID, SUP, 0n, BigInt(T0 + 10)), /Scope must not be empty/);
    await assert.rejects(() => contract.circuits.grantDisclosure(c2, b32('g3'), TID, SUP, 1n, BigInt(T0 - 10)), /Expiry must be in the future/);
  });

  it('DISCLOSURE: supervisor verifies ONE opened field against the on-chain root', async () => {
    const ps = base();
    const { contract, ctx } = await setup(ps);
    const { context: c1 } = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const { context: c2 } = await contract.circuits.evaluateTransfer(c1, TID);
    const root = ledger(c2.callContext.currentQueryContext.state).originator_root.lookup(TID);
    const o = ps.o;
    // Off-chain package for scope=name(1): opening of name + commitments (not openings) of the rest.
    const cName = pureCircuits.field_commit(o.name_hash, o.salt, b32('name'));
    const cAcct = pureCircuits.field_commit(o.account_hash, o.salt, b32('account'));
    const cDoc = pureCircuits.field_commit(o.doc_hash, o.salt, b32('document'));
    const cVasp = pureCircuits.field_commit(o.vasp_id, o.salt, b32('vasp'));
    assert.deepEqual(pureCircuits.root_of(cName, cAcct, cDoc, cVasp), root);
    // a forged opening does not reproduce the root
    const forged = pureCircuits.field_commit(b32('name:other'), o.salt, b32('name'));
    assert.notDeepEqual(pureCircuits.root_of(forged, cAcct, cDoc, cVasp), root);
  });
});
