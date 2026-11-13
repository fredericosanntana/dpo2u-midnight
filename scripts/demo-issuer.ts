/**
 * Demo of compact/examples/ShieldedDepositIssuer.compact.
 *
 *   npx tsx scripts/demo-issuer.ts                       # full scenario in the simulator (no network, no funds)
 *   npx tsx scripts/demo-issuer.ts --plan                # what each step would run on preprod: circuit, key,
 *                                                        # public args, private inputs, ZK sources (no wallet, no network)
 *   npx tsx scripts/demo-issuer.ts --plan --network preview --only issue,answer-check
 *
 * There is no network mode here on purpose: the preprod run (deploy + calls) is the roteiro in
 * docs/ISSUER-EXAMPLE.md and needs the shareholder's go for each transaction.
 * All parties and ids are fictitious.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { COMMANDS, plan, newPS, settle, shareOpening, hex, type Command, type IssuerPS } from './lib/issuer-example.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// The demo sequence, in order, with the (fictitious) arguments it uses.
const SEQUENCE: Array<[Command, Record<string, unknown>]> = [
  ['enroll-psav', { account_id: 'acct:psav-a', passport_id: 'passport:psav-a (fictitious)', holder_commit: 'holder_commitment(<holder secret>, acct:psav-a)' }],
  ['attest-credential', { leaf: 'credential_leaf(<kyc record hash>, <holder salt>, holder_commitment(<holder secret>, acct:retail-1))' }],
  ['enroll-credential', { account_id: 'acct:retail-1' }],
  ['issue', { account_id: 'acct:psav-a', amount: '<private>' }],
  ['redeem', { account_id: 'acct:psav-a', amount: '<private>' }],
  ['register-auditor', { auditor_id: 'auditor:example-firm', key_commit: 'auditor_commitment(<auditor secret>)', scope: 1, expires_at: '<now + 1 day>', budget: 10 }],
  ['request-check', { check_id: 'check-1', auditor_id: 'auditor:example-firm', account_id: 'acct:psav-a', rule: 1, limit: 1_000_000 }],
  ['answer-check', { check_id: 'check-1' }],
  ['freeze', { account_id: 'acct:psav-a', reason_hash: 'sha256(<case file>)', salt: '<random, kept with the case file>' }],
  ['unfreeze', { account_id: 'acct:psav-a', reason_hash: 'sha256(<closing note>)', salt: '<random>' }],
  ['revoke-auditor', { auditor_id: 'auditor:example-firm' }],
  ['status', { account_id: 'acct:psav-a' }],
];

if (flag('--plan')) {
  const network = opt('--network') ?? 'preprod';
  const only = opt('--only')?.split(',');
  for (const c of only ?? []) if (!(COMMANDS as readonly string[]).includes(c)) throw new Error(`unknown command ${c}; one of ${COMMANDS.join(', ')}`);
  const steps = SEQUENCE.filter(([c]) => !only || only.includes(c)).map(([c, a]) => plan(ROOT, network, c, a));
  console.log(JSON.stringify({ plan: true, network, wallet: false, steps }, null, 2));
  process.exit(0);
}
if (opt('--network')) {
  console.error('demo-issuer: network runs are not wired; use --plan, and the preprod roteiro in docs/ISSUER-EXAMPLE.md.');
  process.exit(2);
}

// ── simulator scenario ──
const { simulateIssuer, pure, b32, T0, P_OK, P_REVIEW } = await import('./lib/issuer-example-sim.js');
const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());
const OWNER = b32('demo-issuer-secret-not-a-real-key');
const HOLDER_A = b32('demo-holder-a-not-a-real-key');
const HOLDER_R = b32('demo-holder-r-not-a-real-key');
const AUDITOR = b32('demo-auditor-not-a-real-key');
const ACC_A = b32('acct:psav-a'), ACC_R = b32('acct:retail-1');
const CRED = { credential_hash: sha('kyc-record:retail-1 (fictitious)'), salt: sha('holder-salt:retail-1') };
const AUD = b32('auditor:example-firm');
const ASSET = b32('asset:BRL-deposit (example)');
const reason = (text: string): [Uint8Array, Uint8Array] => [sha(text), sha('reason-salt:' + text)];

const sim = await simulateIssuer(OWNER, ASSET);
const iss = newPS({ ownerSecret: OWNER });
const holA = newPS({ holderSecret: HOLDER_A });
const holR = newPS({ holderSecret: HOLDER_R, credential: CRED });
const aud = newPS({ auditorSecret: AUDITOR });
const log = (step: string, detail = '') => console.log(`✓ ${step}${detail ? ` — ${detail}` : ''}`);
const refused = async (step: string, p: Promise<unknown>) => {
  try { await p; throw new Error(`${step}: expected a revert`); } catch (e: any) { if (/expected a revert/.test(e.message)) throw e; console.log(`✗ ${step} — refused: ${String(e.message).split('\n')[0]}`); }
};
const opened = async (actor: IssuerPS, other: IssuerPS, id: Uint8Array, balance: bigint) => {
  settle(actor, pure, sim.L.balance_commit.lookup(id), id, balance);
  shareOpening(actor, other, id);
};

console.log('== (a) eligibility ==');
await refused('enrollPsav with a REVIEW passport', sim.call('enrollPsav', iss, [ACC_A, P_REVIEW, pure.holder_commitment(HOLDER_A, ACC_A)]));
await sim.call('enrollPsav', iss, [ACC_A, P_OK, pure.holder_commitment(HOLDER_A, ACC_A)]);
log('enrollPsav', 'PsavPassport.isValid checked on chain; account kind 1');
await sim.call('attestCredential', iss, [pure.credential_leaf(sha('decoy'), sha('decoy-salt'), sha('decoy-holder'))]);
await sim.call('attestCredential', iss, [pure.credential_leaf(CRED.credential_hash, CRED.salt, pure.holder_commitment(HOLDER_R, ACC_R))]);
log('attestCredential x2', 'two leaves in the tree; the credential itself never sent');
await refused('credential opening without the holder secret', sim.call('enrollWithCredential', newPS({ holderSecret: b32('thief'), credential: CRED }), [ACC_R]));
await sim.call('enrollWithCredential', holR, [ACC_R]);
log('enrollWithCredential', `nullifier ${hex(pure.credential_nullifier(ASSET, CRED.credential_hash, CRED.salt)).slice(0, 16)}…; which leaf: not published`);
const ACC_R2 = b32('acct:retail-2');
await sim.call('attestCredential', iss, [pure.credential_leaf(CRED.credential_hash, CRED.salt, pure.holder_commitment(HOLDER_R, ACC_R2))]);
await refused('same credential, second account', sim.call('enrollWithCredential', holR, [ACC_R2]));

console.log('== issue / redeem (amounts private) ==');
await sim.call('issue', iss, [ACC_A, 1_000_000n]); await opened(iss, holA, ACC_A, 1_000_000n);
log('issue', `commitment now ${hex(sim.L.balance_commit.lookup(ACC_A)).slice(0, 16)}… (amount not on chain)`);
await sim.call('redeem', holA, [ACC_A, 250_000n]); await opened(holA, iss, ACC_A, 750_000n);
log('redeem by holder', 'issuer and holder books agree on 750000');
await refused('redeem more than the balance', sim.call('redeem', holA, [ACC_A, 750_001n]));

console.log('== (c) auditor key ==');
await sim.call('registerAuditor', iss, [AUD, pure.auditor_commitment(AUDITOR), 1n, BigInt(T0 + 86_400), 2n]);
log('registerAuditor', 'scope CAP, valid 1 day, budget 2 checks');
await sim.call('requestCheck', aud, [b32('check-1'), AUD, ACC_A, 1n, 1_000_000n]);
log('requestCheck by auditor', 'rule CAP, limit 1000000');
log('answerCheck by issuer', `HOLDS=${await sim.call('answerCheck', iss, [b32('check-1')])} (balance not published)`);
await sim.call('requestCheck', aud, [b32('check-2'), AUD, ACC_A, 1n, 500_000n]);
log('answerCheck, limit 500000', `HOLDS=${await sim.call('answerCheck', iss, [b32('check-2')])} -> status VIOLATED`);
await refused('FLOOR check outside the CAP scope', sim.call('requestCheck', aud, [b32('check-3'), AUD, ACC_A, 2n, 1n]));
await refused('third CAP check (budget spent: no bisection of the balance)', sim.call('requestCheck', aud, [b32('check-4'), AUD, ACC_A, 1n, 750_000n]));

console.log('== (b) freeze ==');
await sim.call('freeze', iss, [ACC_A, ...reason('case-file:2026-0042 (fictitious)')]);
log('freeze', 'only a salted commitment of the reason is on chain');
await refused('issue to a frozen account', sim.call('issue', iss, [ACC_A, 1n]));
await refused('redeem from a frozen account', sim.call('redeem', holA, [ACC_A, 1n]));
await sim.call('unfreeze', iss, [ACC_A, ...reason('case-file:2026-0042 closed')]);
log('unfreeze');

console.log('== passport lapse ==');
await sim.suspendPassport(P_OK);
await refused('issue after the PsavPassport was suspended', sim.call('issue', iss, [ACC_A, 1n]));
await sim.call('redeem', holA, [ACC_A, 750_000n]); await opened(holA, iss, ACC_A, 0n);
log('redeem still works', 'lapsed eligibility blocks new issuance, not the exit');
await sim.call('revokeAuditor', iss, [AUD]);
log('revokeAuditor');
const L = sim.L;
console.log(JSON.stringify({ accounts: L.total_accounts, issue_ops: L.total_issue_ops, redeem_ops: L.total_redeem_ops, freezes: L.total_freezes, checks: { 'check-1': L.check_status.lookup(b32('check-1')), 'check-2': L.check_status.lookup(b32('check-2')) } }, (_k, v) => typeof v === 'bigint' ? Number(v) : v));
