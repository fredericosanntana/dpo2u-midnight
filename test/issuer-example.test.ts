/**
 * compact/examples/ShieldedDepositIssuer.compact in the simulator (compactc 0.36 / compact-runtime 0.21).
 * Linked to a simulated PsavPassport (cross-contract isValid), no network. Setup: scripts/lib/issuer-example-sim.ts.
 * Secrets here are test labels; real secrets are 32 random bytes.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicStateHex } from './helpers.js';
import { newPS, settle, shareOpening, plan, hex, COMMANDS, type IssuerPS } from '../scripts/lib/issuer-example.js';
import { simulateIssuer, Issuer, pure, witnesses as W, b32, T0, P_OK, P_OK2, P_REVIEW, type Sim } from '../scripts/lib/issuer-example-sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const ZERO = new Uint8Array(32);
const U64_MAX = 2n ** 64n - 1n;

const OWNER = b32('issuer-owner-secret-test-only');
const HOLDER = b32('holder-secret-test-only');
const AUDITOR = b32('auditor-secret-test-only');
const STRANGER = b32('someone-else-entirely');
const ASSET = b32('asset:BRL-deposit (example)');

const ACC_PSAV = b32('acct:psav-a');
const ACC_CRED = b32('acct:retail-1');
const CRED = { credential_hash: sha('kyc-record:retail-1 (fictitious)'), salt: sha('holder-salt:retail-1') };
const hc = (secret: Uint8Array, acct: Uint8Array) => pure.holder_commitment(secret, acct);
const leafFor = (acct: Uint8Array, cred = CRED, secret = HOLDER) => pure.credential_leaf(cred.credential_hash, cred.salt, hc(secret, acct));
/** [reason_hash, salt] as freeze / unfreeze take them; the circuit stores reason_commitment of the pair. */
const reason = (text: string): [Uint8Array, Uint8Array] => [sha(text), sha('reason-salt:' + text)];
const setup = () => simulateIssuer(OWNER, ASSET);

const issuerPS = () => newPS({ ownerSecret: OWNER });
const holderPS = () => newPS({ holderSecret: HOLDER, credential: CRED });
const auditorPS = () => newPS({ auditorSecret: AUDITOR });
const stranger = () => newPS({ ownerSecret: STRANGER, holderSecret: STRANGER, auditorSecret: STRANGER });

/** Issuer and holder each keep the book; after an op the actor settles and hands the opening over. */
async function issueTo(sys: Sim, iss: IssuerPS, hol: IssuerPS, id: Uint8Array, amount: bigint, expected: bigint) {
  await sys.call('issue', iss, [id, amount]);
  settle(iss, pure, sys.L.balance_commit.lookup(id), id, expected);
  shareOpening(iss, hol, id);
}
async function redeemFrom(sys: Sim, iss: IssuerPS, hol: IssuerPS, id: Uint8Array, amount: bigint, expected: bigint) {
  await sys.call('redeem', hol, [id, amount]);
  settle(hol, pure, sys.L.balance_commit.lookup(id), id, expected);
  shareOpening(hol, iss, id);
}

async function withPsavAccount() {
  const sys = await setup();
  const iss = issuerPS(), hol = holderPS();
  await sys.call('enrollPsav', iss, [ACC_PSAV, P_OK, hc(HOLDER, ACC_PSAV)]);
  return { sys, iss, hol };
}
async function withCredentialAccount() {
  const sys = await setup();
  const iss = issuerPS(), hol = holderPS();
  await sys.call('attestCredential', iss, [pure.credential_leaf(sha('decoy-1'), sha('s1'), sha('h1'))]);
  await sys.call('attestCredential', iss, [leafFor(ACC_CRED)]);
  await sys.call('attestCredential', iss, [pure.credential_leaf(sha('decoy-2'), sha('s2'), sha('h2'))]);
  await sys.call('enrollWithCredential', hol, [ACC_CRED]);
  return { sys, iss, hol };
}

describe('issuer-example: deployment', () => {
  it('constructor sets the sealed config; counters start at zero', async () => {
    const sys = await setup();
    const L = sys.L;
    assert.equal(hex(L.owner_commit), hex(pure.owner_commitment(OWNER)));
    assert.equal(hex(L.asset_id), hex(ASSET));
    assert.equal(L.total_accounts + L.total_issue_ops + L.total_redeem_ops + L.total_freezes, 0n);
  });

  it('role commitments are domain-separated and the holder one is bound to the account', () => {
    const s = b32('same-secret');
    const all = [pure.owner_commitment(s), hc(s, ACC_PSAV), hc(s, ACC_CRED), pure.auditor_commitment(s)].map(hex);
    assert.equal(new Set(all).size, 4);
  });
});

describe('issuer-example: eligibility (a)', () => {
  it('PSAV route: valid passport enrolls; REVIEW, unknown and reused passports and non-issuer are refused', async () => {
    const sys = await setup();
    const iss = issuerPS();
    await assert.rejects(sys.call('enrollPsav', stranger(), [ACC_PSAV, P_OK, hc(HOLDER, ACC_PSAV)]), /Only the issuer can do this/);
    await assert.rejects(sys.call('enrollPsav', iss, [ACC_PSAV, P_REVIEW, hc(HOLDER, ACC_PSAV)]), /PsavPassport is not valid/);
    await assert.rejects(sys.call('enrollPsav', iss, [ACC_PSAV, b32('passport:unknown'), hc(HOLDER, ACC_PSAV)]), /PsavPassport is not valid/);
    await assert.rejects(sys.call('enrollPsav', iss, [ACC_PSAV, P_OK, ZERO]), /Holder commitment must not be zero/);
    await sys.call('enrollPsav', iss, [ACC_PSAV, P_OK, hc(HOLDER, ACC_PSAV)]);
    const L = sys.L;
    assert.equal(L.account_kind.lookup(ACC_PSAV), 1n);
    assert.equal(hex(L.account_passport.lookup(ACC_PSAV)), hex(P_OK));
    assert.equal(hex(L.balance_commit.lookup(ACC_PSAV)), hex(pure.zero_balance_commitment(ACC_PSAV)));
    assert.equal(L.total_accounts, 1n);
    assert.equal(await sys.call('isEligible', iss, [ACC_PSAV]), true);
    await assert.rejects(sys.call('enrollPsav', iss, [b32('acct:other'), P_OK, hc(HOLDER, b32('acct:other'))]), /Passport already bound/);
  });

  it('an account id is used once (second valid passport, same id)', async () => {
    const { sys, iss } = await withPsavAccount();
    await assert.rejects(sys.call('enrollPsav', iss, [ACC_PSAV, P_OK2, hc(HOLDER, ACC_PSAV)]), /Account id already used/);
  });

  it('isEligible is false for an unknown account (no revert)', async () => {
    const sys = await setup();
    assert.equal(await sys.call('isEligible', issuerPS(), [b32('acct:nope')]), false);
  });

  it('credential route: attested credential enrolls; credential, salt, leaf and holder secret stay off the public state', async () => {
    const sys = await setup();
    const iss = issuerPS(), hol = holderPS();
    await sys.call('attestCredential', iss, [pure.credential_leaf(sha('decoy-1'), sha('s1'), sha('h1'))]);
    await assert.rejects(sys.call('attestCredential', stranger(), [leafFor(ACC_CRED)]), /Only the issuer/);
    await assert.rejects(sys.call('enrollWithCredential', hol, [ACC_CRED]), /credential leaf not in the attested tree/);
    await sys.call('attestCredential', iss, [leafFor(ACC_CRED)]);
    await sys.call('attestCredential', iss, [pure.credential_leaf(sha('decoy-2'), sha('s2'), sha('h2'))]);
    await sys.call('enrollWithCredential', hol, [ACC_CRED]);
    const L = sys.L;
    assert.equal(L.account_kind.lookup(ACC_CRED), 2n);
    assert.equal(hex(L.account_holder.lookup(ACC_CRED)), hex(hc(HOLDER, ACC_CRED)));
    assert.ok(L.credential_nullifiers.member(pure.credential_nullifier(ASSET, CRED.credential_hash, CRED.salt)));
    assert.equal(await sys.call('isEligible', iss, [ACC_CRED]), true);
    const pub = publicStateHex(sys.state);
    for (const [name, v] of Object.entries({ credential_hash: CRED.credential_hash, salt: CRED.salt, leaf: leafFor(ACC_CRED), holder_secret: HOLDER })) {
      assert.ok(!pub.includes(hex(v)), `${name} leaked into the public state`);
    }
  });

  it('one credential opens one account: a second attested leaf for the same credential hits the nullifier', async () => {
    const { sys, iss, hol } = await withCredentialAccount();
    const ACC2 = b32('acct:retail-2');
    await sys.call('attestCredential', iss, [leafFor(ACC2)]);
    await assert.rejects(sys.call('enrollWithCredential', hol, [ACC2]), /Credential already used/);
  });

  it('the credential is not a bearer token: its opening without the holder secret is refused', async () => {
    const { sys } = await withCredentialAccount();
    const thief = newPS({ holderSecret: STRANGER, credential: CRED });
    await assert.rejects(sys.call('enrollWithCredential', thief, [b32('acct:thief')]), /credential leaf not in the attested tree/);
  });

  it('a forged path (a real leaf that is not the caller\'s) is refused in-circuit', async () => {
    const sys = await setup();
    const real = leafFor(b32('acct:victim'), { credential_hash: sha('someone-elses-kyc'), salt: sha('their-salt') }, b32('victim'));
    await sys.call('attestCredential', issuerPS(), [real]);
    const thief = newPS({ holderSecret: STRANGER, credential: { credential_hash: sha('not-attested'), salt: sha('x') } });
    const forged: Issuer.Witnesses<IssuerPS> = { ...W, credential_path: (c) => [c.privateState, c.ledger.credentials.findPathForLeaf(real)!] };
    await assert.rejects(sys.call('enrollWithCredential', thief, [b32('acct:thief')], T0, new Issuer.Contract<IssuerPS>(forged)), /Merkle path is not for this credential/);
  });

  it('a path computed before later attestations still verifies (historic root)', async () => {
    const sys = await setup();
    const iss = issuerPS(), hol = holderPS();
    await sys.call('attestCredential', iss, [leafFor(ACC_CRED)]);
    const old = sys.L.credentials.findPathForLeaf(leafFor(ACC_CRED))!;
    for (let i = 0; i < 3; i++) await sys.call('attestCredential', iss, [pure.credential_leaf(sha('later-' + i), sha('s'), sha('h'))]);
    const stale: Issuer.Witnesses<IssuerPS> = { ...W, credential_path: (c) => [c.privateState, old] };
    await sys.call('enrollWithCredential', hol, [ACC_CRED], T0, new Issuer.Contract<IssuerPS>(stale));
    assert.equal(sys.L.account_kind.lookup(ACC_CRED), 2n);
  });
});

describe('issuer-example: issue and redeem (private amounts)', () => {
  it('issue and redeem move the commitment; amounts, balances and salts never reach the public state', async () => {
    const { sys, iss, hol } = await withPsavAccount();
    const salts: Uint8Array[] = [];
    iss.saltSource = () => { const s = sha('salt-' + salts.length); salts.push(s); return s; };
    hol.saltSource = iss.saltSource;
    // distinctive values so a byte scan of the public state is meaningful
    const A1 = 0x0123456789abcdefn, A2 = 0x00fedcba98765432n, R = 0x0011223344556677n;
    await issueTo(sys, iss, hol, ACC_PSAV, A1, A1);
    assert.notEqual(hex(sys.L.balance_commit.lookup(ACC_PSAV)), hex(pure.zero_balance_commitment(ACC_PSAV)));
    await issueTo(sys, iss, hol, ACC_PSAV, A2, A1 + A2);
    await redeemFrom(sys, iss, hol, ACC_PSAV, R, A1 + A2 - R);
    assert.equal(sys.L.total_issue_ops, 2n);
    assert.equal(sys.L.total_redeem_ops, 1n);
    const pub = publicStateHex(sys.state);
    const le = (v: bigint) => Buffer.from(v.toString(16).padStart(16, '0'), 'hex').reverse().toString('hex');
    for (const v of [A1, A2, R, A1 + A2, A1 + A2 - R]) {
      assert.ok(!pub.includes(le(v)) && !pub.includes(v.toString(16).padStart(16, '0')), `value ${v} visible in the public state`);
    }
    for (const s of salts) assert.ok(!pub.includes(hex(s)), 'a balance salt leaked into the public state');
    assert.equal(iss.book.get(hex(ACC_PSAV))!.balance, A1 + A2 - R);
  });

  it('credential account: issue, redeem and an auditor check work end to end', async () => {
    const { sys, iss, hol } = await withCredentialAccount();
    await issueTo(sys, iss, hol, ACC_CRED, 900n, 900n);
    await redeemFrom(sys, iss, hol, ACC_CRED, 100n, 800n);
    await sys.call('registerAuditor', iss, [b32('aud'), pure.auditor_commitment(AUDITOR), 1n, BigInt(T0 + 60), 5n]);
    await sys.call('requestCheck', auditorPS(), [b32('c'), b32('aud'), ACC_CRED, 1n, 800n]);
    assert.equal(await sys.call('answerCheck', iss, [b32('c')]), true);
  });

  it('refusals leave the state untouched: over-redeem, wrong opening, zero amounts, wrong keys, unknown account', async () => {
    const { sys, iss, hol } = await withPsavAccount();
    await issueTo(sys, iss, hol, ACC_PSAV, 100n, 100n);
    const before = hex(sys.L.balance_commit.lookup(ACC_PSAV));
    await assert.rejects(sys.call('redeem', hol, [ACC_PSAV, 101n]), /Insufficient balance/);
    await assert.rejects(sys.call('redeem', hol, [ACC_PSAV, 0n]), /Amount must be positive/);
    await assert.rejects(sys.call('issue', iss, [ACC_PSAV, 0n]), /Amount must be positive/);
    const liar = (base: IssuerPS) => { const p = newPS({ ...base, book: new Map(), pending: new Map() }); p.book.set(hex(ACC_PSAV), { balance: 1_000_000n, salt: iss.book.get(hex(ACC_PSAV))!.salt }); return p; };
    await assert.rejects(sys.call('issue', liar(iss), [ACC_PSAV, 1n]), /Balance opening does not match/);
    await assert.rejects(sys.call('redeem', liar(hol), [ACC_PSAV, 1n]), /Balance opening does not match/);
    await assert.rejects(sys.call('issue', stranger(), [ACC_PSAV, 1n]), /Only the issuer/);
    const other = newPS({ holderSecret: STRANGER }); shareOpening(iss, other, ACC_PSAV);
    await assert.rejects(sys.call('redeem', other, [ACC_PSAV, 1n]), /Only the account holder/);
    await assert.rejects(sys.call('issue', iss, [b32('acct:nope'), 1n]), /Unknown account/);
    assert.equal(hex(sys.L.balance_commit.lookup(ACC_PSAV)), before);
    assert.equal(sys.L.total_redeem_ops, 0n);
    assert.equal(sys.L.total_issue_ops, 1n);
  });

  it('Uint<64> bounds: issuing past the maximum reverts; redeeming the maximum lands on zero', async () => {
    const { sys, iss, hol } = await withPsavAccount();
    await issueTo(sys, iss, hol, ACC_PSAV, U64_MAX, U64_MAX);
    const before = hex(sys.L.balance_commit.lookup(ACC_PSAV));
    await assert.rejects(sys.call('issue', iss, [ACC_PSAV, 1n]));
    assert.equal(hex(sys.L.balance_commit.lookup(ACC_PSAV)), before);
    await redeemFrom(sys, iss, hol, ACC_PSAV, U64_MAX, 0n);
  });

  it('passport suspended: new issuance stops, redemption still works', async () => {
    const { sys, iss, hol } = await withPsavAccount();
    await issueTo(sys, iss, hol, ACC_PSAV, 500n, 500n);
    await sys.suspendPassport(P_OK);
    assert.equal(await sys.call('isEligible', iss, [ACC_PSAV]), false);
    await assert.rejects(sys.call('issue', iss, [ACC_PSAV, 1n]), /Account is not eligible/);
    await redeemFrom(sys, iss, hol, ACC_PSAV, 500n, 0n);
  });

  it('settle refuses a wrong expected balance and a missing pending salt', async () => {
    const { sys, iss } = await withPsavAccount();
    await sys.call('issue', iss, [ACC_PSAV, 10n]);
    assert.throws(() => settle(iss, pure, sys.L.balance_commit.lookup(ACC_PSAV), ACC_PSAV, 11n), /does not open/);
    settle(iss, pure, sys.L.balance_commit.lookup(ACC_PSAV), ACC_PSAV, 10n);
    assert.throws(() => settle(iss, pure, sys.L.balance_commit.lookup(ACC_PSAV), ACC_PSAV, 10n), /no pending salt/);
  });
});

describe('issuer-example: freeze (b)', () => {
  it('freeze blocks issue and redeem and records only the reason commitment; unfreeze restores', async () => {
    const { sys, iss, hol } = await withPsavAccount();
    await issueTo(sys, iss, hol, ACC_PSAV, 300n, 300n);
    const why = reason('case-file:2026-0042 (fictitious)');
    await assert.rejects(sys.call('freeze', stranger(), [ACC_PSAV, ...why]), /Only the issuer/);
    await assert.rejects(sys.call('freeze', iss, [ACC_PSAV, ZERO, why[1]]), /Reason hash must not be zero/);
    await assert.rejects(sys.call('freeze', iss, [ACC_PSAV, why[0], ZERO]), /Reason salt must not be zero/);
    await assert.rejects(sys.call('freeze', iss, [b32('acct:nope'), ...why]), /Unknown account/);
    await sys.call('freeze', iss, [ACC_PSAV, ...why]);
    assert.ok(sys.L.frozen.member(ACC_PSAV));
    assert.equal(hex(sys.L.freeze_reason.lookup(ACC_PSAV)), hex(pure.reason_commitment(...why)));
    assert.ok(!publicStateHex(sys.state).includes(hex(why[0])), 'the case-file hash itself is on chain');
    assert.equal(await sys.call('isEligible', iss, [ACC_PSAV]), false);
    await assert.rejects(sys.call('freeze', iss, [ACC_PSAV, ...why]), /already frozen/);
    await assert.rejects(sys.call('issue', iss, [ACC_PSAV, 1n]), /Account is frozen/);
    await assert.rejects(sys.call('redeem', hol, [ACC_PSAV, 1n]), /Account is frozen/);
    const lift = reason('case-file:2026-0042 closed');
    await assert.rejects(sys.call('unfreeze', stranger(), [ACC_PSAV, ...lift]), /Only the issuer/);
    await assert.rejects(sys.call('unfreeze', iss, [ACC_PSAV, ZERO, lift[1]]), /Reason hash must not be zero/);
    await sys.call('unfreeze', iss, [ACC_PSAV, ...lift]);
    assert.ok(!sys.L.frozen.member(ACC_PSAV));
    assert.equal(hex(sys.L.unfreeze_reason.lookup(ACC_PSAV)), hex(pure.reason_commitment(...lift)));
    await assert.rejects(sys.call('unfreeze', iss, [ACC_PSAV, ...lift]), /not frozen/);
    await issueTo(sys, iss, hol, ACC_PSAV, 1n, 301n);
    await redeemFrom(sys, iss, hol, ACC_PSAV, 101n, 200n);
    assert.equal(sys.L.total_freezes, 1n);
  });
});

describe('issuer-example: auditor key (c)', () => {
  const AUD = b32('auditor:example-firm (fictitious)');
  async function withAuditor(scope: bigint, budget = 10n, expires = BigInt(T0 + 86_400)) {
    const ctx = await withPsavAccount();
    await issueTo(ctx.sys, ctx.iss, ctx.hol, ACC_PSAV, 5_000n, 5_000n);
    await ctx.sys.call('registerAuditor', ctx.iss, [AUD, pure.auditor_commitment(AUDITOR), scope, expires, budget]);
    return ctx;
  }

  it('registration rules: issuer only, non-zero key, scope 1..3, future expiry, positive budget, id once', async () => {
    const { sys, iss } = await withPsavAccount();
    const k = pure.auditor_commitment(AUDITOR);
    const exp = BigInt(T0 + 10);
    await assert.rejects(sys.call('registerAuditor', stranger(), [AUD, k, 1n, exp, 5n]), /Only the issuer/);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, ZERO, 1n, exp, 5n]), /Auditor key must not be zero/);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, k, 0n, exp, 5n]), /Scope must be/);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, k, 4n, exp, 5n]), /Scope must be/);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, k, 1n, BigInt(T0 - 10), 5n]), /Expiry must be in the future/);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, k, 1n, exp, 0n]), /Check budget must be positive/);
    await sys.call('registerAuditor', iss, [AUD, k, 1n, exp, 5n]);
    await assert.rejects(sys.call('registerAuditor', iss, [AUD, k, 1n, exp, 5n]), /already used/);
    assert.equal(sys.L.auditor_budget.lookup(AUD), 5n);
    assert.equal(await sys.call('isAuditorActive', iss, [AUD]), true);
    assert.equal(await sys.call('isAuditorActive', iss, [AUD], T0 + 10), false, 'expiry is exclusive');
    assert.equal(await sys.call('isAuditorActive', iss, [b32('auditor:unknown')]), false);
    await assert.rejects(sys.call('revokeAuditor', stranger(), [AUD]), /Only the issuer/);
    await assert.rejects(sys.call('revokeAuditor', iss, [b32('auditor:unknown')]), /Unknown auditor/);
  });

  it('CAP check: HOLDS / VIOLATED is all that is published; the balance is not', async () => {
    const { sys, iss } = await withAuditor(1n);
    const aud = auditorPS();
    await sys.call('requestCheck', aud, [b32('check-1'), AUD, ACC_PSAV, 1n, 10_000n]);
    assert.equal(sys.L.check_status.lookup(b32('check-1')), 1n);
    assert.equal(await sys.call('answerCheck', iss, [b32('check-1')]), true);
    assert.equal(sys.L.check_status.lookup(b32('check-1')), 2n);
    await sys.call('requestCheck', aud, [b32('check-2'), AUD, ACC_PSAV, 1n, 4_999n]);
    assert.equal(await sys.call('answerCheck', iss, [b32('check-2')]), false);
    assert.equal(sys.L.check_status.lookup(b32('check-2')), 3n);
    await sys.call('requestCheck', aud, [b32('check-3'), AUD, ACC_PSAV, 1n, 5_000n]);
    assert.equal(await sys.call('answerCheck', iss, [b32('check-3')]), true, 'balance == limit holds');
    await assert.rejects(sys.call('answerCheck', iss, [b32('check-1')]), /already answered/);
    await assert.rejects(sys.call('answerCheck', iss, [b32('check-nope')]), /Unknown check/);
    await sys.call('requestCheck', aud, [b32('check-4'), AUD, ACC_PSAV, 1n, 1n]);
    await assert.rejects(sys.call('answerCheck', stranger(), [b32('check-4')]), /Only the issuer/);
    assert.ok(!publicStateHex(sys.state).includes(hex(iss.book.get(hex(ACC_PSAV))!.salt)), 'balance salt leaked');
  });

  it('the check budget bounds how much an auditor can learn by repeated questions', async () => {
    const { sys, iss } = await withAuditor(1n, 3n);
    const aud = auditorPS();
    for (let i = 0; i < 3; i++) {
      await sys.call('requestCheck', aud, [b32('b-' + i), AUD, ACC_PSAV, 1n, BigInt(1000 * (i + 1))]);
      await sys.call('answerCheck', iss, [b32('b-' + i)]);
    }
    assert.equal(sys.L.auditor_budget.lookup(AUD), 0n);
    await assert.rejects(sys.call('requestCheck', aud, [b32('b-3'), AUD, ACC_PSAV, 1n, 4500n]), /budget exhausted/);
  });

  it('scope, key, account, revocation and expiry are enforced', async () => {
    const { sys, iss } = await withAuditor(1n);
    const aud = auditorPS();
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-floor'), AUD, ACC_PSAV, 2n, 1n]), /outside the auditor's scope/);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-bad'), AUD, ACC_PSAV, 3n, 1n]), /Rule must be 1/);
    await assert.rejects(sys.call('requestCheck', stranger(), [b32('c-x'), AUD, ACC_PSAV, 1n, 1n]), /Only the registered auditor/);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-x'), b32('auditor:unknown'), ACC_PSAV, 1n, 1n]), /Unknown auditor/);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-x'), AUD, b32('acct:nope'), 1n, 1n]), /Unknown account/);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-late'), AUD, ACC_PSAV, 1n, 1n], T0 + 86_401), /Auditor key expired/);
    await sys.call('requestCheck', aud, [b32('c-ok'), AUD, ACC_PSAV, 1n, 1n]);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-ok'), AUD, ACC_PSAV, 1n, 1n]), /Check id already used/);
    // the auditor must still be active when the answer lands
    await assert.rejects(sys.call('answerCheck', iss, [b32('c-ok')], T0 + 86_401), /Auditor key expired/);
    await sys.call('revokeAuditor', iss, [AUD]);
    await assert.rejects(sys.call('answerCheck', iss, [b32('c-ok')]), /Auditor revoked/);
    await assert.rejects(sys.call('requestCheck', aud, [b32('c-2'), AUD, ACC_PSAV, 1n, 1n]), /Auditor revoked/);
  });

  it('the answer is about the balance the auditor asked about: issuing in between blocks the answer', async () => {
    const { sys, iss, hol } = await withAuditor(2n);
    await sys.call('requestCheck', auditorPS(), [b32('floor-1'), AUD, ACC_PSAV, 2n, 6_000n]);
    assert.equal(hex(sys.L.check_commit.lookup(b32('floor-1'))), hex(sys.L.balance_commit.lookup(ACC_PSAV)));
    await issueTo(sys, iss, hol, ACC_PSAV, 1_000n, 6_000n);   // would make the FLOOR hold
    await assert.rejects(sys.call('answerCheck', iss, [b32('floor-1')]), /Balance changed since the check was requested/);
    assert.equal(sys.L.check_status.lookup(b32('floor-1')), 1n, 'stays REQUESTED, on the public record');
  });

  it('FLOOR check with scope 3', async () => {
    const { sys, iss } = await withAuditor(3n);
    const aud = auditorPS();
    await sys.call('requestCheck', aud, [b32('f-1'), AUD, ACC_PSAV, 2n, 5_000n]);
    assert.equal(await sys.call('answerCheck', iss, [b32('f-1')]), true);
    await sys.call('requestCheck', aud, [b32('f-2'), AUD, ACC_PSAV, 2n, 5_001n]);
    assert.equal(await sys.call('answerCheck', iss, [b32('f-2')]), false);
  });
});

describe('issuer-example: plan', () => {
  it('every planned circuit exists in the compiled contract', () => {
    const circuits = Object.keys(new Issuer.Contract<IssuerPS>(W).circuits);
    for (const c of COMMANDS) {
      const p = plan(ROOT, 'preprod', c, {});
      if (p.circuit) assert.ok(circuits.includes(p.circuit), `${c} -> ${p.circuit} missing`);
    }
  });

  it('issue and enroll-psav carry the passport call and both ZK sources; answer-check does not; only public args echo', () => {
    for (const c of ['issue', 'enroll-psav'] as const) {
      const p = plan(ROOT, 'preprod', c, {});
      assert.match(String(p.crossContract), /PsavPassport.isValid/);
      assert.deepEqual(p.zkSources, ['build/ShieldedDepositIssuer', 'build/PsavPassport']);
    }
    const i = plan(ROOT, 'preprod', 'issue', { account_id: 'acct:x', amount: '123' });
    assert.ok(i.privateInputs.includes('amount'));
    assert.deepEqual(i.args, { account_id: 'acct:x' });
    const a = plan(ROOT, 'preprod', 'answer-check', {});
    assert.equal(a.crossContract, null);
    assert.deepEqual(a.zkSources, ['build/ShieldedDepositIssuer']);
    assert.match(plan(ROOT, 'preprod', 'request-check', {}).key, /auditor/);
    assert.equal(plan(ROOT, 'preprod', 'status', {}).transaction, false);
    assert.throws(() => plan(ROOT, 'preprod', 'mint' as any, {}), /unknown command/);
  });
});
