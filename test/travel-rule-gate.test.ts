/**
 * TravelRuleGate — PASS and FAIL cases, shielded party data, policy-stamped verdicts, two-key
 * disclosure grants, and the cross-contract links (v10): a counterparty with a valid PsavPassport
 * passes the VASP check; release requires this VASP's attestation in the ComplianceRegistry.
 * Runs against the compiled contracts in the Compact runtime simulator (no network).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, createConstructorContext, type CircuitContext } from '@midnight-ntwrk/compact-runtime';
import * as Gate from '../build/TravelRuleGate/contract/index.js';
import * as Passport from '../build/PsavPassport/contract/index.js';
import * as Registry from '../build/ComplianceRegistry/contract/index.js';
import { publicStateHex, simAddress, contractRef, asDeployed, crossContract, SIM_BLOCK_HASH } from './helpers.js';
import { newProviderKey, signSanctionsList, sanctionsListRoot, toPayload, fromPayload, type SanctionsListWitness } from '../scripts/lib/sanctions-list.js';

const { Contract, ledger, pureCircuits } = Gate;

type Party = { name_hash: Uint8Array; account_hash: Uint8Array; doc_hash: Uint8Array; vasp_id: Uint8Array; salt: Uint8Array };
type PS = { o: Party; b: Party; amount: bigint; sanctionsClear: boolean; secret: Uint8Array; approver: Uint8Array; list: SanctionsListWitness };

const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const ZERO = new Uint8Array(32);
const CPK = '0'.repeat(64);
const OWNER_SECRET = b32('owner-secret-test-only');
const APPROVER_SECRET = b32('approver-secret-test-only');
const THRESHOLD = 100_000n; // R$ 1.000,00 in cents (fictional threshold)
const BENEF_VASP = b32('vasp:counterparty-A');
const PASSPORT_VASP = b32('vasp:with-passport');
const REVOKED_VASP = b32('vasp:passport-revoked');
const SHORT_VASP = b32('vasp:passport-31-days');
const SELF_COMPANY = b32('company:example-vasp');
const POLICY = b32('policy:travel-rule@1.0.0');
const PURPOSE = b32('purpose:bcb-inquiry-0001');
const T0 = 1_800_000_000;
const MONTH = 2_678_400;

const GATE = simAddress(0x6a7e), PASSPORT = simAddress(0x9a55), REGISTRY = simAddress(0x4e61);

const witnesses = {
  originator_data: (c: any) => [c.privateState, c.privateState.o] as [PS, Party],
  beneficiary_data: (c: any) => [c.privateState, c.privateState.b] as [PS, Party],
  transfer_amount: (c: any) => [c.privateState, c.privateState.amount] as [PS, bigint],
  sanctions_clear: (c: any) => [c.privateState, c.privateState.sanctionsClear] as [PS, boolean],
  owner_secret: (c: any) => [c.privateState, c.privateState.secret] as [PS, Uint8Array],
  approver_secret: (c: any) => [c.privateState, c.privateState.approver] as [PS, Uint8Array],
  sanctions_list: (c: any) => [c.privateState, c.privateState.list] as [PS, SanctionsListWitness],
};

// Sanctions-list provider (fictitious) and a snapshot valid for one day from T0.
const PROVIDER = new Uint8Array(Buffer.from('aa'.repeat(32), 'hex'));
const PROVIDER_KEY = newProviderKey();
const LIST_ROOT = sanctionsListRoot(['11'.repeat(32), '22'.repeat(32)]);
const DAY = 86_400;
const signedList = (o: Partial<{ sk: bigint; provider_id: Uint8Array; list_root: Uint8Array; issued_at: bigint; valid_until: bigint }> = {}) =>
  signSanctionsList(Gate, o.sk ?? PROVIDER_KEY.sk, { provider_id: o.provider_id ?? PROVIDER, list_root: o.list_root ?? LIST_ROOT, issued_at: o.issued_at ?? BigInt(T0 - 3600), valid_until: o.valid_until ?? BigInt(T0 + DAY) });
const LIST = signedList();

const party = (n: string, withDoc: boolean, vasp = b32('vasp:own')): Party => ({
  name_hash: b32('name:' + n), account_hash: b32('acct:' + n),
  doc_hash: withDoc ? b32('doc:' + n) : ZERO, vasp_id: vasp, salt: b32('salt:' + n),
});

function base(over: Partial<PS> = {}): PS {
  return { o: party('orig', true), b: party('benef', true, BENEF_VASP), amount: 250_000n, sanctionsClear: true, secret: OWNER_SECRET, approver: APPROVER_SECRET, list: LIST, ...over };
}

// ── Linked contracts, deployed in the simulator ──
const run = async (contract: any, circuit: string, state: any, ps: any, t: number, ...args: unknown[]) => {
  const r = await contract.circuits[circuit](createCircuitContext({
    circuitId: circuit, contractAddress: simAddress(0xffff), coinPublicKeyOrZswapState: CPK,
    contractState: state, privateState: ps, time: t,
  } as any), ...args);
  return r.context.callContext.currentQueryContext.state;
};

/** PsavPassport with: PASSPORT_VASP valid (tier 1, 1 year), REVOKED_VASP revoked, SHORT_VASP valid 31 days (tier 2). */
async function passportState() {
  const issuer = b32('issuer-secret-test-only');
  const ps = {
    secret: issuer, origins: [1n, 1n, 2n, 3n, ...Array(12).fill(0n)], verdicts: [1n, 1n, 1n, 1n, ...Array(12).fill(0n)],
    partnerId: b32('FICTITIOUS-VASP'), salt: b32('partner-salt'), reviewerSig: b32('reviewer-sig'), evidence: b32('evidence'), sponsorSecret: b32('x'),
  };
  const fields: Record<string, string> = { owner_secret: 'secret', rule_origins: 'origins', rule_verdicts: 'verdicts', partner_id: 'partnerId', commit_salt: 'salt', reviewer_sig_hash: 'reviewerSig', evidence_hash: 'evidence', sponsor_secret: 'sponsorSecret' };
  const w = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, (c: any) => [c.privateState, c.privateState[f]]]));
  const c = new Passport.Contract(w as any);
  const { currentContractState: init } = await c.initialState(createConstructorContext(ps, CPK), Passport.pureCircuits.owner_commitment(issuer));
  const issued = T0 - 3600;
  let s: any = init.data;
  s = await run(c, 'issuePassport', s, ps, T0, PASSPORT_VASP, b32('pack'), b32('1.0.0'), 1n, BigInt(issued), BigInt(issued + 31_536_000));
  s = await run(c, 'issuePassport', s, ps, T0, REVOKED_VASP, b32('pack'), b32('1.0.0'), 1n, BigInt(issued), BigInt(issued + 31_536_000));
  s = await run(c, 'revokePassport', s, ps, T0, REVOKED_VASP);
  s = await run(c, 'issuePassport', s, ps, T0, SHORT_VASP, b32('pack'), b32('1.0.0'), 2n, BigInt(issued), BigInt(issued + MONTH));
  return asDeployed(init, s, 'PsavPassport');
}

/** ComplianceRegistry, with SELF_COMPANY attested when `attested`. */
async function registryState(attested: boolean) {
  const sec = b32('registry-owner-test-only');
  const ps = { secret: sec, salt: b32('score-salt') };
  const c = new Registry.Contract({ owner_secret: (x: any) => [x.privateState, x.privateState.secret], score_salt: (x: any) => [x.privateState, x.privateState.salt] } as any);
  const { currentContractState: init } = await c.initialState(createConstructorContext(ps, CPK), Registry.pureCircuits.owner_commitment(sec));
  let s: any = init.data;
  if (attested) s = await run(c, 'attestCompliance', s, ps, T0, SELF_COMPANY, b32('did:agent'), b32('cid'), 70n, b32('ctx-1'), 85n, b32('evidence'));
  return asDeployed(init, s, 'ComplianceRegistry');
}

async function setup(ps: PS, opts: { attested?: boolean } = {}) {
  const contract = new Contract<PS>(witnesses as any);
  const cross = crossContract({
    [PASSPORT]: { state: await passportState(), module: Passport },
    [REGISTRY]: { state: await registryState(opts.attested ?? true), module: Registry },
  });
  const { currentContractState } = await contract.initialState(
    createConstructorContext(ps, CPK), pureCircuits.owner_commitment(OWNER_SECRET), THRESHOLD,
    contractRef(PASSPORT), contractRef(REGISTRY), SELF_COMPANY, pureCircuits.approver_commitment(APPROVER_SECRET));
  const mk = (state: any, p: PS = ps, t = T0): CircuitContext<PS> => createCircuitContext({
    circuitId: 'test', contractAddress: GATE, coinPublicKeyOrZswapState: CPK,
    contractState: state, privateState: p, time: t, parentBlockHash: SIM_BLOCK_HASH, crossContract: cross,
  } as any);
  // The owner registers the sanctions-list provider before any evaluation.
  const reg = await contract.circuits.registerSanctionsProvider(mk(currentContractState), PROVIDER, PROVIDER_KEY.pk);
  return { contract, ctx: mk(reg.context.callContext.currentQueryContext.state), mk };
}

/** Ledger state after a call; the next call starts from a fresh context over it. */
const st = (r: { context: any }) => r.context.callContext.currentQueryContext.state;
const TID = b32('transfer-1');

describe('TravelRuleGate', () => {
  it('PASS: complete data, attested counterparty -> verdict 1, policy stamped, then release -> 3', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(mk(st(a)), TID, POLICY);
    assert.equal(r.result, 1n);
    const L = ledger(st(r));
    assert.equal(L.status.lookup(TID), 1n);
    assert.equal(L.fail_reason.lookup(TID), 0n);
    assert.deepEqual(L.verdict_policy.lookup(TID), POLICY);
    assert.equal(L.total_pass, 1n);
    const rel = await contract.circuits.releaseTransfer(mk(st(r)), TID);
    assert.equal(ledger(st(rel)).status.lookup(TID), 3n);
    assert.equal(ledger(st(rel)).total_released, 1n);
  });

  it('a zero policy hash is refused', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(a)), TID, ZERO), /Policy hash must not be zero/);
  });

  it('PASSPORT: counterparty with a valid PsavPassport passes without attestVasp', async () => {
    const { contract, ctx } = await setup(base({ b: party('benef', true, PASSPORT_VASP) }));
    const r = await contract.circuits.evaluateTransfer(ctx, TID, POLICY);
    assert.equal(r.result, 1n);
    assert.equal(ledger(st(r)).fail_reason.lookup(TID), 0n);
  });

  it('PASSPORT: revoked passport -> reason 3; expired passport (block time past expiry) -> reason 3', async () => {
    const rv = await setup(base({ b: party('benef', true, REVOKED_VASP) }));
    const r1 = await rv.contract.circuits.evaluateTransfer(rv.ctx, TID, POLICY);
    assert.equal(r1.result, 2n);
    assert.equal(ledger(st(r1)).fail_reason.lookup(TID), 3n);

    const ps = base({ b: party('benef', true, SHORT_VASP) });
    const ex = await setup(ps);
    // control: within its 31-day window the same passport passes
    assert.equal((await ex.contract.circuits.evaluateTransfer(ex.mk(ex.ctx.callContext.currentQueryContext.state), TID, POLICY)).result, 1n);
    // a sanctions list still valid two months later, so only the passport expiry is under test
    const late = ex.mk(ex.ctx.callContext.currentQueryContext.state, { ...ps, list: signedList({ valid_until: BigInt(T0 + 3 * MONTH) }) }, T0 + 2 * MONTH);
    const r2 = await ex.contract.circuits.evaluateTransfer(late, TID, POLICY);
    assert.equal(r2.result, 2n);
    assert.equal(ledger(st(r2)).fail_reason.lookup(TID), 3n);
  });

  it('REGISTRY: release reverts when this VASP has no compliance attestation', async () => {
    const { contract, ctx, mk } = await setup(base(), { attested: false });
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(mk(st(a)), TID, POLICY);
    assert.equal(r.result, 1n);
    await assert.rejects(() => contract.circuits.releaseTransfer(mk(st(r)), TID), /no compliance attestation/);
  });

  it('FAIL: counterparty VASP not attested -> verdict 2 reason 3, release reverts', async () => {
    const { contract, ctx, mk } = await setup(base());
    const r = await contract.circuits.evaluateTransfer(ctx, TID, POLICY);
    assert.equal(r.result, 2n);
    const L = ledger(st(r));
    assert.equal(L.status.lookup(TID), 2n);
    assert.equal(L.fail_reason.lookup(TID), 3n);
    assert.equal(L.total_fail, 1n);
    await assert.rejects(() => contract.circuits.releaseTransfer(mk(st(r)), TID), /Travel Rule not satisfied/);
  });

  it('FAIL: above threshold without originator document -> reason 2; below threshold the same data passes', async () => {
    const a = await setup(base({ o: party('orig', false) }));
    const a1 = await a.contract.circuits.attestVasp(a.ctx, BENEF_VASP);
    const r = await a.contract.circuits.evaluateTransfer(a.mk(st(a1)), TID, POLICY);
    assert.equal(r.result, 2n);
    assert.equal(ledger(st(r)).fail_reason.lookup(TID), 2n);

    const s = await setup(base({ o: party('orig', false), amount: 50_000n }));
    const s1 = await s.contract.circuits.attestVasp(s.ctx, BENEF_VASP);
    assert.equal((await s.contract.circuits.evaluateTransfer(s.mk(st(s1)), TID, POLICY)).result, 1n);
  });

  it('FAIL: missing beneficiary info -> reason 1; sanctions hit -> reason 4', async () => {
    const miss = await setup(base({ b: { ...party('benef', true, BENEF_VASP), account_hash: ZERO } }));
    const m1 = await miss.contract.circuits.attestVasp(miss.ctx, BENEF_VASP);
    assert.equal(ledger(st(await miss.contract.circuits.evaluateTransfer(miss.mk(st(m1)), TID, POLICY))).fail_reason.lookup(TID), 1n);

    const sx = await setup(base({ sanctionsClear: false }));
    const s1 = await sx.contract.circuits.attestVasp(sx.ctx, BENEF_VASP);
    assert.equal(ledger(st(await sx.contract.circuits.evaluateTransfer(sx.mk(st(s1)), TID, POLICY))).fail_reason.lookup(TID), 4n);
  });

  it('PRIVACY: public state holds no raw party data, only salted roots', async () => {
    const ps = base();
    const { contract, ctx, mk } = await setup(ps);
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const c2 = await contract.circuits.evaluateTransfer(mk(st(c1)), TID, POLICY);
    const blob = publicStateHex(st(c2)); // full public ledger state, hex-rendered
    for (const secret of [ps.o.name_hash, ps.o.account_hash, ps.o.doc_hash, ps.b.name_hash, ps.b.account_hash, ps.o.salt, APPROVER_SECRET]) {
      assert.ok(!blob.includes(Buffer.from(secret).toString('hex')), 'raw private field leaked into public state');
    }
    const L = ledger(st(c2));
    // control: the scan does see public values (the root and the attested VASP id are in the blob)
    assert.ok(blob.includes(Buffer.from(L.originator_root.lookup(TID)).toString('hex')), 'scan control failed');
    assert.equal(L.originator_root.lookup(TID).length, 32);
    assert.notDeepEqual(L.originator_root.lookup(TID), L.beneficiary_root.lookup(TID));
  });

  it('evaluate twice is rejected; non-owner cannot release or grant', async () => {
    const { contract, ctx, mk } = await setup(base());
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const c2 = await contract.circuits.evaluateTransfer(mk(st(c1)), TID, POLICY);
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(c2)), TID, POLICY), /already evaluated/);
    const stranger = base({ secret: b32('not-the-owner') });
    await assert.rejects(() => contract.circuits.releaseTransfer(mk(st(c2), stranger), TID), /Only the VASP owner/);
    await assert.rejects(() => contract.circuits.grantDisclosure(mk(st(c2), stranger), b32('g'), TID, b32('sup'), 1n, BigInt(T0 + 3600), PURPOSE), /Only the VASP owner/);
  });

  it('a non-owner cannot evaluate a transfer', async () => {
    const { contract, ctx, mk } = await setup(base());
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const intruder = mk(st(c1), base({ secret: b32('not-the-owner') }));
    await assert.rejects(() => contract.circuits.evaluateTransfer(intruder, TID, POLICY), /Only the VASP owner can do this/);
    assert.equal(ledger(st(c1)).status.member(TID), false);
  });

  it('constructor refuses approver_commit equal to owner_commit', async () => {
    const contract = new Contract<PS>(witnesses as any);
    const oc = pureCircuits.owner_commitment(OWNER_SECRET);
    await assert.rejects(async () => contract.initialState(createConstructorContext(base(), CPK), oc, THRESHOLD,
      contractRef(PASSPORT), contractRef(REGISTRY), SELF_COMPANY, oc), /Approver must differ from owner/);
  });

  it('DISCLOSURE: grant is a request (inactive), the owner cannot approve, the approver activates it; purpose recorded', async () => {
    const { contract, ctx, mk } = await setup(base());
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const c2 = await contract.circuits.evaluateTransfer(mk(st(c1)), TID, POLICY);
    const G = b32('grant-bcb-1'), SUP = b32('supervisor:BCB');
    const c3 = await contract.circuits.grantDisclosure(mk(st(c2)), G, TID, SUP, 0b0001n, BigInt(T0 + 3600), PURPOSE);
    const L = ledger(st(c3));
    assert.equal(L.grant_scope.lookup(G), 1n);
    assert.deepEqual(L.grant_purpose.lookup(G), PURPOSE);
    assert.equal(L.grant_approved.member(G), false);
    assert.equal((await contract.circuits.isGrantActive(mk(st(c3)), G)).result, false, 'inactive before approval');
    // the owner (owner secret in the approver slot) cannot approve
    await assert.rejects(() => contract.circuits.approveDisclosure(mk(st(c3), base({ approver: OWNER_SECRET })), G), /Only the disclosure approver can do this/);
    const c4 = await contract.circuits.approveDisclosure(mk(st(c3)), G);
    assert.equal(ledger(st(c4)).grant_approved.member(G), true);
    assert.equal((await contract.circuits.isGrantActive(mk(st(c4)), G)).result, true);
    await assert.rejects(() => contract.circuits.approveDisclosure(mk(st(c4)), G), /already approved/);
    await assert.rejects(() => contract.circuits.approveDisclosure(mk(st(c4)), b32('nope')), /Unknown grant/);
    await assert.rejects(() => contract.circuits.grantDisclosure(mk(st(c2)), b32('g0'), TID, SUP, 1n, BigInt(T0 + 3600), ZERO), /Purpose hash must not be zero/);
  });

  it('DISCLOSURE: approved grant expires with block time and can be revoked; a revoked request cannot be approved', async () => {
    const { contract, ctx, mk } = await setup(base());
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const c2 = await contract.circuits.evaluateTransfer(mk(st(c1)), TID, POLICY);
    const G = b32('grant-bcb-1'), SUP = b32('supervisor:BCB');
    const c3 = await contract.circuits.grantDisclosure(mk(st(c2)), G, TID, SUP, 0b0001n, BigInt(T0 + 3600), PURPOSE);
    const c4 = await contract.circuits.approveDisclosure(mk(st(c3)), G);
    assert.equal((await contract.circuits.isGrantActive(mk(st(c4)), G)).result, true);
    assert.equal((await contract.circuits.isGrantActive(mk(st(c4), base(), T0 + 7200), G)).result, false);
    const c5 = await contract.circuits.revokeDisclosure(mk(st(c4)), G);
    assert.equal((await contract.circuits.isGrantActive(mk(st(c5)), G)).result, false);
    const r3 = await contract.circuits.revokeDisclosure(mk(st(c3)), G);
    await assert.rejects(() => contract.circuits.approveDisclosure(mk(st(r3)), G), /Grant revoked/);
    // empty scope and past expiry rejected
    await assert.rejects(() => contract.circuits.grantDisclosure(mk(st(c2)), b32('g2'), TID, SUP, 0n, BigInt(T0 + 10), PURPOSE), /Scope must not be empty/);
    await assert.rejects(() => contract.circuits.grantDisclosure(mk(st(c2)), b32('g3'), TID, SUP, 1n, BigInt(T0 - 10), PURPOSE), /Expiry must be in the future/);
  });

  it('DISCLOSURE: supervisor verifies ONE opened field against the on-chain root', async () => {
    const ps = base();
    const { contract, ctx, mk } = await setup(ps);
    const c1 = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const c2 = await contract.circuits.evaluateTransfer(mk(st(c1)), TID, POLICY);
    const root = ledger(st(c2)).originator_root.lookup(TID);
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

  it('DISCLOSURE: the opening carries one field blinding, not the party salt; it reproduces field_commit', () => {
    const o = base().o;
    const bl = pureCircuits.field_blinding(o.salt, b32('name'));
    assert.deepEqual(pureCircuits.field_commit_blinded(o.name_hash, bl), pureCircuits.field_commit(o.name_hash, o.salt, b32('name')));
    // the name blinding does not open another field
    assert.notDeepEqual(pureCircuits.field_commit_blinded(o.account_hash, bl), pureCircuits.field_commit(o.account_hash, o.salt, b32('account')));
  });

  // ── hardening 2026-11-13 ──
  it('HARDENING: party salts must be non-zero and different', async () => {
    const zero = await setup(base({ o: { ...party('orig', true), salt: ZERO } }));
    const a = await zero.contract.circuits.attestVasp(zero.ctx, BENEF_VASP);
    await assert.rejects(() => zero.contract.circuits.evaluateTransfer(zero.mk(st(a)), TID, POLICY), /Party salt must not be zero/);
    const same = base();
    same.b = { ...same.b, salt: same.o.salt };
    const s2 = await setup(same);
    const a2 = await s2.contract.circuits.attestVasp(s2.ctx, BENEF_VASP);
    await assert.rejects(() => s2.contract.circuits.evaluateTransfer(s2.mk(st(a2)), TID, POLICY), /salts must differ/);
  });

  it('HARDENING: release re-checks the screening: list expired or provider revoked since the verdict -> refused', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(mk(st(a)), TID, POLICY);
    await assert.rejects(() => contract.circuits.releaseTransfer(mk(st(r), base(), T0 + DAY), TID), /Sanctions list behind the verdict expired/);
    const rv = await contract.circuits.revokeSanctionsProvider(mk(st(r)), PROVIDER);
    await assert.rejects(() => contract.circuits.releaseTransfer(mk(st(rv)), TID), /Sanctions provider revoked since the verdict/);
    const ok = await contract.circuits.releaseTransfer(mk(st(r), base(), T0 + DAY - 1), TID);
    assert.equal(ledger(st(ok)).status.lookup(TID), 3n);
  });

  it('HARDENING: four eyes in-circuit: an approver_commit built from the OWNER secret still cannot approve', async () => {
    const contract = new Contract<PS>(witnesses as any);
    const cross = crossContract({ [PASSPORT]: { state: await passportState(), module: Passport }, [REGISTRY]: { state: await registryState(true), module: Registry } });
    // the constructor check passes: different domains, so the two commitments differ
    const { currentContractState } = await contract.initialState(createConstructorContext(base(), CPK), pureCircuits.owner_commitment(OWNER_SECRET), THRESHOLD,
      contractRef(PASSPORT), contractRef(REGISTRY), SELF_COMPANY, pureCircuits.approver_commitment(OWNER_SECRET));
    const mk = (state: any, p: PS = base({ approver: OWNER_SECRET })) => createCircuitContext({ circuitId: 't', contractAddress: GATE, coinPublicKeyOrZswapState: CPK, contractState: state, privateState: p, time: T0, parentBlockHash: SIM_BLOCK_HASH, crossContract: cross } as any);
    const reg = await contract.circuits.registerSanctionsProvider(mk(currentContractState), PROVIDER, PROVIDER_KEY.pk);
    const a = await contract.circuits.attestVasp(mk(st(reg)), BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(mk(st(a)), TID, POLICY);
    const G = b32('grant-1');
    const g = await contract.circuits.grantDisclosure(mk(st(r)), G, TID, b32('supervisor:BCB'), 1n, BigInt(T0 + 3600), PURPOSE);
    await assert.rejects(() => contract.circuits.approveDisclosure(mk(st(g)), G), /The owner key cannot approve a disclosure/);
  });

  // ── signed sanctions lists (v10-signed-sanctions) ──
  it('SANCTIONS: the verdict records the signed list root, provider and valid_until', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const r = await contract.circuits.evaluateTransfer(mk(st(a)), TID, POLICY);
    const L = ledger(st(r));
    assert.deepEqual(L.verdict_sanctions_root.lookup(TID), LIST_ROOT);
    assert.deepEqual(L.verdict_sanctions_provider.lookup(TID), PROVIDER);
    assert.equal(L.verdict_sanctions_valid_until.lookup(TID), BigInt(T0 + DAY));
  });

  it('SANCTIONS: refuses an unsigned/forged list, an unregistered provider and a tampered root', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const s0 = st(a);
    const other = newProviderKey();
    const forged = signedList({ sk: other.sk });
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(s0, base({ list: forged })), TID, POLICY), /Sanctions list signature invalid/);
    const unsigned = { ...LIST, signature: { announcement: LIST.signature.announcement, response: 0n } };
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(s0, base({ list: unsigned })), TID, POLICY), /Sanctions list signature invalid/);
    const tampered = { ...LIST, list_root: sanctionsListRoot(['33'.repeat(32)]) };
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(s0, base({ list: tampered })), TID, POLICY), /Sanctions list signature invalid/);
    const stranger = signedList({ sk: other.sk, provider_id: new Uint8Array(32).fill(0xbb) });
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(s0, base({ list: stranger })), TID, POLICY), /Sanctions provider not registered/);
    assert.equal(ledger(s0).status.member(TID), false);
  });

  it('SANCTIONS: refuses an expired list (block time at or past valid_until) and an empty window', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(a), base(), T0 + DAY), TID, POLICY), /Sanctions list expired/);
    const stale = signedList({ issued_at: BigInt(T0 - 3 * DAY), valid_until: BigInt(T0 - DAY) });
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(a), base({ list: stale })), TID, POLICY), /Sanctions list expired/);
    const empty = { ...LIST, valid_until: LIST.issued_at };
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(a), base({ list: empty })), TID, POLICY), /validity window is empty/);
  });

  it('SANCTIONS: the owner revokes and rotates a provider; old keys stop working; only the owner manages providers', async () => {
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    const rv = await contract.circuits.revokeSanctionsProvider(mk(st(a)), PROVIDER);
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(rv)), TID, POLICY), /Sanctions provider revoked/);
    const next = newProviderKey();
    const rot = await contract.circuits.registerSanctionsProvider(mk(st(rv)), PROVIDER, next.pk);
    await assert.rejects(() => contract.circuits.evaluateTransfer(mk(st(rot)), TID, POLICY), /Sanctions list signature invalid/, 'list signed with the rotated-out key');
    const ok = await contract.circuits.evaluateTransfer(mk(st(rot), base({ list: signedList({ sk: next.sk }) })), TID, POLICY);
    assert.equal(ok.result, 1n);
    const stranger = base({ secret: b32('not-the-owner') });
    await assert.rejects(() => contract.circuits.registerSanctionsProvider(mk(st(a), stranger), PROVIDER, next.pk), /Only the VASP owner/);
    await assert.rejects(() => contract.circuits.revokeSanctionsProvider(mk(st(a), stranger), PROVIDER), /Only the VASP owner/);
    await assert.rejects(() => contract.circuits.revokeSanctionsProvider(mk(st(a)), new Uint8Array(32).fill(1)), /Unknown sanctions provider/);
  });

  it('SANCTIONS: gateway payload round-trips and is validated', async () => {
    const p = toPayload(LIST);
    assert.match(p.signature.response, /^\d+$/);
    const back = fromPayload(JSON.parse(JSON.stringify(p)));
    assert.deepEqual(back.list_root, LIST.list_root);
    assert.equal(back.signature.response, LIST.signature.response);
    const { contract, ctx, mk } = await setup(base());
    const a = await contract.circuits.attestVasp(ctx, BENEF_VASP);
    assert.equal((await contract.circuits.evaluateTransfer(mk(st(a), base({ list: back })), TID, POLICY)).result, 1n);
    assert.throws(() => fromPayload({ ...p, signature: undefined }), /missing: signature/);
    assert.throws(() => fromPayload({ ...p, valid_until: p.issued_at }), /valid_until > issued_at/);
    assert.throws(() => fromPayload({ ...p, list_root: 'XYZ' }), /lowercase hex/);
  });
});
