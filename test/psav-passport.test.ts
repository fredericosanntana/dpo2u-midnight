/**
 * PsavPassport — issuance (PASS / FAIL / REVIEW recorded), time expiry, suspension/revocation,
 * issuer-only, sponsorship by commitment, and a public-state privacy scan.
 * Runs against the compiled contract in the Compact runtime simulator (no network).
 * The VASP below is FICTITIOUS (test data only).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCircuitContext, createConstructorContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import * as fs from 'node:fs';
import { Contract, ledger, pureCircuits } from '../build/PsavPassport/contract/index.js';

type PS = {
  secret: Uint8Array; origins: bigint[]; verdicts: bigint[];
  partnerId: Uint8Array; salt: Uint8Array; reviewerSig: Uint8Array; evidence: Uint8Array; sponsorSecret: Uint8Array;
};

const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const ZERO = new Uint8Array(32);
const OWNER_SECRET = b32('issuer-secret-test-only');
const T0 = 1_800_000_000;
const YEAR = 31_536_000, MONTH = 2_678_400;
const ISSUED = T0 - 3600;
const PID = b32('passport-1');

const pad16 = (xs: number[]) => { const a = xs.map(BigInt); while (a.length < 16) a.push(0n); return a; };
// origins: 1 machine, 2 human, 3 third_party. verdicts: 1 PASS, 2 FAIL, 3 REVIEW.
const rules = (os: number[], vs: number[]) => ({ origins: pad16(os), verdicts: pad16(vs) });

const witnesses = {
  owner_secret: (c: any) => [c.privateState, c.privateState.secret],
  rule_origins: (c: any) => [c.privateState, c.privateState.origins],
  rule_verdicts: (c: any) => [c.privateState, c.privateState.verdicts],
  partner_id: (c: any) => [c.privateState, c.privateState.partnerId],
  commit_salt: (c: any) => [c.privateState, c.privateState.salt],
  reviewer_sig_hash: (c: any) => [c.privateState, c.privateState.reviewerSig],
  evidence_hash: (c: any) => [c.privateState, c.privateState.evidence],
  sponsor_secret: (c: any) => [c.privateState, c.privateState.sponsorSecret],
};

function base(over: Partial<PS> = {}): PS {
  return {
    secret: OWNER_SECRET, ...rules([1, 1, 2, 3], [1, 1, 1, 1]),
    partnerId: b32('FICTITIOUS-VASP-CNPJ-00.000.000/0001-00'), salt: b32('partner-salt-test-only'),
    reviewerSig: b32('reviewer-signature-hash-test'), evidence: b32('evidence-sha256-test-only'),
    sponsorSecret: b32('fictitious-spsav-secret'), ...over,
  };
}

async function setup(ps: PS) {
  const contract = new Contract<PS>(witnesses as any);
  const cpk = '0'.repeat(64);
  const { currentContractState } = await contract.initialState(
    createConstructorContext(ps, cpk), pureCircuits.owner_commitment(OWNER_SECRET));
  const mk = (state: any, p: PS, t = T0) => createCircuitContext({
    circuitId: 'test', contractAddress: dummyContractAddress(), coinPublicKeyOrZswapState: cpk,
    contractState: state, privateState: p, time: t,
  } as any);
  return { contract, ctx: mk(currentContractState, ps), mk };
}
const PACK = b32('pack-hash-psav-partner@1.0.0');
const VER = b32('1.0.0');
async function issue(s: Awaited<ReturnType<typeof setup>>, ctx: any, id = PID, tier = 1n, issued = ISSUED, win = YEAR) {
  return await s.contract.circuits.issuePassport(ctx, id, PACK, VER, tier, BigInt(issued), BigInt(issued + win));
}
const L = (c: any) => ledger(c.callContext.currentQueryContext.state);

describe('PsavPassport', () => {
  it('PASS: tier1 with every rule PASS and a reviewer signature commitment -> valid', async () => {
    const s = await setup(base());
    const r = await issue(s, s.ctx);
    assert.equal(r.result, 1n);
    const l = L(r.context);
    assert.equal(l.verdict.lookup(PID), 1n);
    assert.equal(l.status.lookup(PID), 1n);
    assert.equal(l.tier.lookup(PID), 1n);
    assert.equal(l.issued_at.lookup(PID), BigInt(ISSUED));
    assert.equal(l.expires_at.lookup(PID), BigInt(ISSUED + YEAR));
    assert.deepEqual([l.machine_rules.lookup(PID), l.human_rules.lookup(PID), l.third_party_rules.lookup(PID)], [2n, 1n, 1n]);
    assert.deepEqual(l.pack_hash.lookup(PID), PACK);
    assert.equal(l.total_pass, 1n);
    assert.notDeepEqual(l.reviewer_commit.lookup(PID), ZERO);
    assert.equal((await s.contract.circuits.isValid(r.context, PID)).result, true);
    const v = (await s.contract.circuits.verifyPassport(r.context, PID)).result;
    assert.deepEqual([v.exists, v.verdict, v.valid, v.status], [true, 1n, true, 1n]);
  });

  it('PASS: tier1-machine-only with human/third-party rules still pending (REVIEW) is valid', async () => {
    const s = await setup(base({ ...rules([1, 1, 2, 3], [1, 1, 3, 3]), reviewerSig: ZERO }));
    const r = await issue(s, s.ctx, PID, 0n);
    assert.equal(r.result, 1n);
    assert.deepEqual(L(r.context).reviewer_commit.lookup(PID), ZERO);
    assert.equal((await s.contract.circuits.isValid(r.context, PID)).result, true);
  });

  it('FAIL recorded (not refused): a machine rule FAIL -> verdict 2, status ACTIVE, never valid', async () => {
    const s = await setup(base(rules([1, 1, 2, 3], [1, 2, 1, 1])));
    const r = await issue(s, s.ctx);
    assert.equal(r.result, 2n);
    const l = L(r.context);
    assert.equal(l.verdict.lookup(PID), 2n);
    assert.equal(l.total_issued, 1n);
    assert.equal(l.total_pass, 0n);
    assert.equal((await s.contract.circuits.isValid(r.context, PID)).result, false);
    const v = (await s.contract.circuits.verifyPassport(r.context, PID)).result;
    assert.deepEqual([v.exists, v.verdict, v.valid], [true, 2n, false]);
  });

  it('REVIEW recorded: pending human rule at tier1, and tier1 PASS without reviewer commitment -> verdict 3, not valid', async () => {
    const a = await setup(base(rules([1, 2], [1, 3])));
    const ra = await issue(a, a.ctx);
    assert.equal(ra.result, 3n);
    assert.equal((await a.contract.circuits.isValid(ra.context, PID)).result, false);

    const b = await setup(base({ ...rules([1, 1], [1, 1]), reviewerSig: ZERO }));
    const rb = await issue(b, b.ctx);
    assert.equal(rb.result, 3n);
    assert.equal((await b.contract.circuits.verifyPassport(rb.context, PID)).result.verdict, 3n);
    assert.equal((await b.contract.circuits.isValid(rb.context, PID)).result, false);

    // machine-only with zero machine rules verifies nothing -> REVIEW
    const c = await setup(base({ ...rules([2, 3], [3, 3]), reviewerSig: ZERO }));
    assert.equal((await issue(c, c.ctx, PID, 0n)).result, 3n);
  });

  it('rejects malformed input: PASS on human rule without reviewer, bad slots, window mismatch, duplicate id', async () => {
    const noRev = await setup(base({ ...rules([1, 2], [1, 1]), reviewerSig: ZERO }));
    await assert.rejects(() => issue(noRev, noRev.ctx), /requires the reviewer signature/);
    const badSlot = await setup(base(rules([1, 7], [1, 1])));
    await assert.rejects(() => issue(badSlot, badSlot.ctx), /Invalid rule slot/);
    const ghost = await setup(base({ origins: pad16([1]), verdicts: pad16([1, 0]).map((x, i) => (i === 5 ? 1n : x)) }));
    await assert.rejects(() => issue(ghost, ghost.ctx), /Invalid rule slot/);
    const empty = await setup(base(rules([], [])));
    await assert.rejects(() => issue(empty, empty.ctx), /No rules evaluated/);
    const s = await setup(base());
    await assert.rejects(() => issue(s, s.ctx, PID, 1n, ISSUED, YEAR - 1), /does not match the tier window/);
    await assert.rejects(() => issue(s, s.ctx, PID, 2n, ISSUED, YEAR), /does not match the tier window/);
    await assert.rejects(() => issue(s, s.ctx, PID, 1n, T0 + 10, YEAR), /issued_at is in the future/);
    await assert.rejects(() => issue(s, s.ctx, PID, 1n, T0 - YEAR - 10, YEAR), /Validity window already closed/);
    await assert.rejects(() => issue(s, s.ctx, PID, 9n), /Unknown tier/);
    const r = await issue(s, s.ctx);
    await assert.rejects(() => issue(s, r.context), /already used/);
    // tier2 uses the 31-day window
    const t2 = await issue(s, s.ctx, b32('p-t2'), 2n, ISSUED, MONTH);
    assert.equal(L(t2.context).expires_at.lookup(b32('p-t2')), BigInt(ISSUED + MONTH));
  });

  it('EXPIRY by time: valid before expires_at, invalid after, markExpired only after the window', async () => {
    const s = await setup(base());
    const r = await issue(s, s.ctx);
    const exp = ISSUED + YEAR;
    const before = s.mk(r.context.callContext.currentQueryContext.state, base(), exp - 1);
    assert.equal((await s.contract.circuits.isValid(before, PID)).result, true);
    await assert.rejects(() => s.contract.circuits.markExpired(before, PID), /still open/);
    const after = s.mk(r.context.callContext.currentQueryContext.state, base(), exp);
    assert.equal((await s.contract.circuits.isValid(after, PID)).result, false);
    const v = (await s.contract.circuits.verifyPassport(after, PID)).result;
    assert.deepEqual([v.verdict, v.valid, v.status], [1n, false, 1n]); // verdict kept; validity lapsed
    // permissionless: even a non-issuer records EXPIRED
    const stranger = s.mk(r.context.callContext.currentQueryContext.state, base({ secret: b32('stranger') }), exp);
    const m = await s.contract.circuits.markExpired(stranger, PID);
    assert.equal(L(m.context).status.lookup(PID), 4n);
    await assert.rejects(() => s.contract.circuits.markExpired(m.context, PID), /terminal/);
    const issuerAfter = s.mk(m.context.callContext.currentQueryContext.state, base(), exp);
    await assert.rejects(() => s.contract.circuits.revokePassport(issuerAfter, PID), /terminal/);
  });

  it('SUSPEND and REVOKE: issuer only, invalid afterwards, REVOKED is terminal', async () => {
    const s = await setup(base());
    const r = await issue(s, s.ctx);
    const sus = await s.contract.circuits.suspendPassport(r.context, PID);
    assert.equal(L(sus.context).status.lookup(PID), 2n);
    assert.equal((await s.contract.circuits.isValid(sus.context, PID)).result, false);
    await assert.rejects(() => s.contract.circuits.suspendPassport(sus.context, PID), /Only an ACTIVE/);
    const rev = await s.contract.circuits.revokePassport(sus.context, PID);
    assert.equal(L(rev.context).status.lookup(PID), 3n);
    assert.equal((await s.contract.circuits.isValid(rev.context, PID)).result, false);
    assert.equal((await s.contract.circuits.verifyPassport(rev.context, PID)).result.status, 3n);
    await assert.rejects(() => s.contract.circuits.revokePassport(rev.context, PID), /terminal/);
    await assert.rejects(() => s.contract.circuits.suspendPassport(rev.context, PID), /Only an ACTIVE/);
    // revoke straight from ACTIVE; unknown ids rejected
    const direct = await s.contract.circuits.revokePassport(r.context, PID);
    assert.equal(L(direct.context).status.lookup(PID), 3n);
    await assert.rejects(() => s.contract.circuits.revokePassport(r.context, b32('nope')), /Unknown passport/);
    // unknown id verifies as non-existent
    const u = (await s.contract.circuits.verifyPassport(r.context, b32('nope'))).result;
    assert.deepEqual([u.exists, u.verdict, u.valid, u.status], [false, 0n, false, 0n]);
  });

  it('NON-ISSUER is refused: issue, suspend and revoke', async () => {
    const s = await setup(base());
    const intruder = s.mk(s.ctx.callContext.currentQueryContext.state, base({ secret: b32('not-the-issuer') }));
    await assert.rejects(() => issue(s, intruder), /Only the passport issuer/);
    const r = await issue(s, s.ctx);
    const intr2 = s.mk(r.context.callContext.currentQueryContext.state, base({ secret: b32('not-the-issuer') }));
    await assert.rejects(() => s.contract.circuits.suspendPassport(intr2, PID), /Only the passport issuer/);
    await assert.rejects(() => s.contract.circuits.revokePassport(intr2, PID), /Only the passport issuer/);
  });

  it('PRIVACY: public state holds no raw partner id, salt, evidence hash, reviewer signature or per-rule verdicts', async () => {
    const ps = base();
    const s = await setup(ps);
    const r = await issue(s, s.ctx);
    const blob = String(r.context.callContext.currentQueryContext.state);
    for (const raw of [ps.partnerId, ps.salt, ps.evidence, ps.reviewerSig, ps.sponsorSecret, OWNER_SECRET]) {
      assert.ok(!blob.includes(hex(raw)), 'raw private field leaked into public state');
    }
    assert.ok(!blob.includes(Buffer.from('FICTITIOUS-VASP-CNPJ').toString('hex')), 'partner id text leaked');
    const l = L(r.context);
    // control: the scan does see public values
    assert.ok(blob.includes(hex(l.partner_commit.lookup(PID))), 'scan control failed');
    // commitments reproduce only with the opening, and differ per label
    assert.deepEqual(pureCircuits.labeled_commit(ps.partnerId, ps.salt, b32('partner')), l.partner_commit.lookup(PID));
    assert.deepEqual(pureCircuits.labeled_commit(ps.evidence, ps.salt, b32('evidence')), l.evidence_commit.lookup(PID));
    assert.notDeepEqual(pureCircuits.labeled_commit(ps.partnerId, b32('wrong-salt'), b32('partner')), l.partner_commit.lookup(PID));
    assert.notDeepEqual(l.partner_commit.lookup(PID), l.evidence_commit.lookup(PID));
  });

  it('SPONSORSHIP: SPSAV proposes, only the partner consents (by commitment), follows passport validity and min tier', async () => {
    const ps = base();
    const s = await setup(ps);
    const SID = b32('sponsorship-1');
    const r = await issue(s, s.ctx);
    await assert.rejects(() => s.contract.circuits.proposeSponsorship(r.context, SID, b32('nope'), 1n), /Unknown passport/);
    const p = await s.contract.circuits.proposeSponsorship(r.context, SID, PID, 1n);
    assert.equal(L(p.context).sp_status.lookup(SID), 1n);
    assert.equal((await s.contract.circuits.isSponsorshipActive(p.context, SID)).result, false); // proposed != active
    await assert.rejects(() => s.contract.circuits.proposeSponsorship(p.context, SID, PID, 1n), /already used/);
    // a different party (wrong id/salt) cannot consent
    const wrong = s.mk(p.context.callContext.currentQueryContext.state, base({ partnerId: b32('someone-else') }));
    await assert.rejects(() => s.contract.circuits.consentSponsorship(wrong, SID), /Only the passport partner/);
    const spsavAsPartner = s.mk(p.context.callContext.currentQueryContext.state, base({ partnerId: ps.sponsorSecret }));
    await assert.rejects(() => s.contract.circuits.consentSponsorship(spsavAsPartner, SID), /Only the passport partner/);
    // the partner consents
    const partnerView = s.mk(p.context.callContext.currentQueryContext.state, ps);
    const c = await s.contract.circuits.consentSponsorship(partnerView, SID);
    const l = L(c.context);
    assert.equal(l.sp_status.lookup(SID), 2n);
    assert.notDeepEqual(l.sp_consent_commit.lookup(SID), ZERO);
    assert.equal((await s.contract.circuits.isSponsorshipActive(c.context, SID)).result, true);
    await assert.rejects(() => s.contract.circuits.consentSponsorship(c.context, SID), /not awaiting consent/);
    // the sponsor is a commitment, not the secret
    assert.deepEqual(l.sp_sponsor.lookup(SID), pureCircuits.owner_commitment(ps.sponsorSecret));
    assert.ok(!String(c.context.callContext.currentQueryContext.state).includes(hex(ps.sponsorSecret)));
    // passport leaves valid -> sponsorship inactive (suspension, expiry)
    const sus = await s.contract.circuits.suspendPassport(c.context, PID);
    assert.equal((await s.contract.circuits.isSponsorshipActive(sus.context, SID)).result, false);
    const late = s.mk(c.context.callContext.currentQueryContext.state, ps, ISSUED + YEAR);
    assert.equal((await s.contract.circuits.isSponsorshipActive(late, SID)).result, false);
    // min tier above the passport tier never activates
    const hi = await s.contract.circuits.proposeSponsorship(r.context, b32('sponsorship-hi'), PID, 3n);
    const hic = await s.contract.circuits.consentSponsorship(s.mk(hi.context.callContext.currentQueryContext.state, ps), b32('sponsorship-hi'));
    assert.equal((await s.contract.circuits.isSponsorshipActive(hic.context, b32('sponsorship-hi'))).result, false);
    // a FAIL passport never sponsors
    const f = await setup(base(rules([1, 2], [2, 1])));
    const fr = await issue(f, f.ctx);
    const fp = await f.contract.circuits.proposeSponsorship(fr.context, SID, PID, 0n);
    const fc = await f.contract.circuits.consentSponsorship(f.mk(fp.context.callContext.currentQueryContext.state, base(rules([1, 2], [2, 1]))), SID);
    assert.equal((await f.contract.circuits.isSponsorshipActive(fc.context, SID)).result, false);
  });

  it('EXAMPLE from the real PSAV engine (fictitious VASP): slots from examples/ issue as REVIEW, not valid', async () => {
    const ex = JSON.parse(fs.readFileSync(new URL('../examples/psav-passport-example.json', import.meta.url), 'utf8'));
    assert.ok(ex.examples.length >= 1);
    for (const e of ex.examples) {
      const s = await setup(base({ origins: e.slots.origins.map(BigInt), verdicts: e.slots.verdicts.map(BigInt), reviewerSig: ZERO, evidence: Buffer.from(e.evidenceSha256, 'hex') }));
      const r = await s.contract.circuits.issuePassport(s.ctx, PID, Buffer.from(e.pack.hash, 'hex'), b32(e.pack.version), 1n, BigInt(ISSUED), BigInt(ISSUED + YEAR));
      assert.equal(r.result, 3n, `${e.useCase}: no reviewer yet, engine says REVIEW`);
      assert.equal((await s.contract.circuits.isValid(r.context, PID)).result, false);
    }
  });
});
