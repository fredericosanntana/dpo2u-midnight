/**
 * End-to-end local demo (simulator, no network, no funds):
 *  1) Travel Rule gate (v10, linked to PsavPassport + ComplianceRegistry in the simulator): one PASS
 *     (counterparty attested), one PASS via a valid PsavPassport, one FAIL, for "Example VASP Ltda
 *     (fictitious)"; release needs the VASP's own ComplianceRegistry attestation; on-chain grant
 *     request + approval by the second key.
 *  2) Disclosure: "BCB" key sees only name of originator; blocked outside scope; expires; revoked.
 *  3) Evidence pack built from the results and verified.
 * npx tsx scripts/demo-travel-rule.ts <workDir>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../build/TravelRuleGate/contract/index.js';
import * as Passport from '../build/PsavPassport/contract/index.js';
import * as Registry from '../build/ComplianceRegistry/contract/index.js';
import { simAddress, contractRef, asDeployed, crossContract, SIM_BLOCK_HASH } from './lib/sim-cross-contract.js';
import { newProviderKey, signSanctionsList, sanctionsListRoot } from './lib/sanctions-list.js';
import { DisclosureGovernance, type DataSource, type Field, type Party as P } from '../src/disclosure/governance.js';
import { buildPack, verifyPack, type Attestation } from '../src/evidence/pack.js';

const work = path.resolve(process.argv[2] ?? './demo-out');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const b32 = (s: string) => { const x = Buffer.alloc(32); Buffer.from(s).copy(x, 0, 0, 32); return new Uint8Array(x); };
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const ZERO = new Uint8Array(32);
const party = (n: string, doc: boolean, vasp: string) => ({ name_hash: b32('name:' + n), account_hash: b32('acct:' + n), doc_hash: doc ? b32('doc:' + n) : ZERO, vasp_id: b32(vasp), salt: b32('salt:' + n) });
const OWNER = b32('demo-owner-secret-not-a-real-key');
const APPROVER = b32('demo-approver-secret-not-a-real');
const CPK = '0'.repeat(64);
const NOW = 1_800_000_000;
const GATE = simAddress(0x6a7e), PASSPORT = simAddress(0x9a55), REGISTRY = simAddress(0x4e61);
const SELF = b32('company:example-vasp (fictitious)');
const POLICY = b32('policy:travel-rule@1.0.0');
const PASSPORT_VASP = 'vasp:with-passport (fictitious)';

// compact-runtime 0.21: initialState and circuits are async; state threads through callContext.
const step = async (c: any, circuit: string, state: any, ps: any, ...args: unknown[]) => (await c.circuits[circuit](createCircuitContext({
  circuitId: circuit, contractAddress: simAddress(0xffff), coinPublicKeyOrZswapState: CPK, contractState: state, privateState: ps, time: NOW,
} as any), ...args)).context.callContext.currentQueryContext.state;

// Linked contracts in the simulator: a PsavPassport with one valid passport, a registry where this VASP is attested.
const issuer = b32('demo-issuer-secret');
const pps = { secret: issuer, origins: [1n, 1n, ...Array(14).fill(0n)], verdicts: [1n, 1n, ...Array(14).fill(0n)], partnerId: b32('FICTITIOUS'), salt: b32('s'), reviewerSig: b32('r'), evidence: b32('e'), sponsorSecret: b32('x') };
const pw = Object.fromEntries(Object.entries({ owner_secret: 'secret', rule_origins: 'origins', rule_verdicts: 'verdicts', partner_id: 'partnerId', commit_salt: 'salt', reviewer_sig_hash: 'reviewerSig', evidence_hash: 'evidence', sponsor_secret: 'sponsorSecret' }).map(([k, f]) => [k, (c: any) => [c.privateState, (c.privateState as any)[f]]]));
const passport = new Passport.Contract(pw as any);
const pInit = (await passport.initialState(createConstructorContext(pps, CPK), Passport.pureCircuits.owner_commitment(issuer))).currentContractState;
const pState = await step(passport, 'issuePassport', pInit.data, pps, b32(PASSPORT_VASP), b32('pack'), b32('1.0.0'), 0n, BigInt(NOW - 3600), BigInt(NOW - 3600 + 31_536_000));
const regSecret = b32('demo-registry-owner');
const rps = { s: regSecret, salt: b32('demo-score-salt') };
const registry = new Registry.Contract({ owner_secret: (c: any) => [c.privateState, c.privateState.s], score_salt: (c: any) => [c.privateState, c.privateState.salt] } as any);
const rInit = (await registry.initialState(createConstructorContext(rps, CPK), Registry.pureCircuits.owner_commitment(regSecret))).currentContractState;
const rState = await step(registry, 'attestCompliance', rInit.data, rps, SELF, b32('did:demo:agent'), b32('policy-cid'), 70n, b32('ctx-demo-1'), 85n, b32('evidence-demo'));
const cross = crossContract({
  [PASSPORT]: { state: asDeployed(pInit, pState, 'PsavPassport'), module: Passport },
  [REGISTRY]: { state: asDeployed(rInit, rState, 'ComplianceRegistry'), module: Registry },
});

type PS = { o: any; b: any; amount: bigint; clear: boolean };
const contract = new Contract<PS>({
  originator_data: (c: any) => [c.privateState, c.privateState.o], beneficiary_data: (c: any) => [c.privateState, c.privateState.b],
  transfer_amount: (c: any) => [c.privateState, c.privateState.amount], sanctions_clear: (c: any) => [c.privateState, c.privateState.clear],
  owner_secret: (c: any) => [c.privateState, OWNER], approver_secret: (c: any) => [c.privateState, APPROVER],
  sanctions_list: (c: any) => [c.privateState, LIST],
} as any);
// Sanctions list: a fictitious provider signs one snapshot, valid one day.
const PROVIDER = new Uint8Array(32).fill(0xaa);
const providerKey = newProviderKey();
const LIST = signSanctionsList({ pureCircuits } as any, providerKey.sk, { provider_id: PROVIDER, list_root: sanctionsListRoot(['11'.repeat(32)]), issued_at: BigInt(NOW - 3600), valid_until: BigInt(NOW + 86_400) });

const { currentContractState } = await contract.initialState(createConstructorContext({} as any, CPK), pureCircuits.owner_commitment(OWNER), 100_000n,
  contractRef(PASSPORT), contractRef(REGISTRY), SELF, pureCircuits.approver_commitment(APPROVER));
let state: any = currentContractState;
const run = async <T>(ps: PS, f: (ctx: any) => Promise<{ context: any; result: T }>) => {
  const r = await f(createCircuitContext({
    circuitId: 'demo', contractAddress: GATE, coinPublicKeyOrZswapState: CPK,
    contractState: state, privateState: ps, time: NOW, parentBlockHash: SIM_BLOCK_HASH, crossContract: cross,
  } as any));
  state = r.context.callContext.currentQueryContext.state; return r.result;
};

const COUNTERPARTY = 'vasp:counterparty-A (fictitious)';
const t1: PS = { o: party('orig-1', true, 'vasp:example'), b: party('benef-1', true, COUNTERPARTY), amount: 250_000n, clear: true };
const t2: PS = { o: party('orig-2', false, 'vasp:example'), b: party('benef-2', true, 'vasp:unknown'), amount: 250_000n, clear: true };
const t3: PS = { o: party('orig-3', true, 'vasp:example'), b: party('benef-3', true, PASSPORT_VASP), amount: 250_000n, clear: true };
await run(t1, (c) => contract.circuits.registerSanctionsProvider(c, PROVIDER, providerKey.pk));
await run(t1, (c) => contract.circuits.attestVasp(c, b32(COUNTERPARTY)));
const ids = { pass: b32('transfer-PASS-001'), fail: b32('transfer-FAIL-002'), passport: b32('transfer-PASSPORT-003') };
const v1 = await run(t1, (c) => contract.circuits.evaluateTransfer(c, ids.pass, POLICY));
const v2 = await run(t2, (c) => contract.circuits.evaluateTransfer(c, ids.fail, POLICY));
const v3 = await run(t3, (c) => contract.circuits.evaluateTransfer(c, ids.passport, POLICY));
await run(t1, (c) => contract.circuits.releaseTransfer(c, ids.pass));
let blocked = false;
try { await run(t2, (c) => contract.circuits.releaseTransfer(c, ids.fail)); } catch (e: any) { blocked = /not satisfied/.test(e.message); }
// on-chain disclosure: the owner requests, the approver (second key) activates
const G = b32('grant-BCB-001');
await run(t1, (c) => contract.circuits.grantDisclosure(c, G, ids.pass, b32('supervisor:BCB (fictitious)'), 1n, BigInt(NOW + 3600), b32('purpose:fictitious-inquiry-0001')));
const before = await run(t1, (c) => contract.circuits.isGrantActive(c, G));
await run(t1, (c) => contract.circuits.approveDisclosure(c, G));
const after = await run(t1, (c) => contract.circuits.isGrantActive(c, G));
const L = ledger(state);
console.log(`[1] travel rule: PASS verdict=${v1} (status after release=${L.status.lookup(ids.pass)}), FAIL verdict=${v2} reason=${L.fail_reason.lookup(ids.fail)}, release of FAIL blocked=${blocked}`);
console.log(`[1] counterparty with a valid PsavPassport (not attested by this VASP): verdict=${v3}; policy hash stamped=${hex(L.verdict_policy.lookup(ids.pass)) === hex(POLICY)}`);
console.log(`[1] on-chain grant: active before approval=${before}, after approval by the second key=${after}`);

const atts: Attestation[] = [
  { id: 'att-001', type: 'travel_rule_verdict', transfer_id: hex(ids.pass), verdict: 'RELEASED', reason_code: 0, originator_root: hex(L.originator_root.lookup(ids.pass)), beneficiary_root: hex(L.beneficiary_root.lookup(ids.pass)), policy_hash: hex(L.verdict_policy.lookup(ids.pass)), source: 'simulator', contract_address: null, tx_hash: null },
  { id: 'att-002', type: 'travel_rule_verdict', transfer_id: hex(ids.fail), verdict: 'FAIL', reason_code: Number(L.fail_reason.lookup(ids.fail)), originator_root: hex(L.originator_root.lookup(ids.fail)), beneficiary_root: hex(L.beneficiary_root.lookup(ids.fail)), policy_hash: hex(L.verdict_policy.lookup(ids.fail)), source: 'simulator', contract_address: null, tx_hash: null },
];

// --- disclosure
const clock = { t: Math.floor(Date.now() / 1000) };
const logPath = path.join(work, 'disclosure', 'access-log.jsonl');
const gov = new DisclosureGovernance(randomBytes(32), logPath, () => clock.t);
const T = hex(ids.pass);
const fieldMap: Record<string, Uint8Array> = { name: t1.o.name_hash, account: t1.o.account_hash, document: t1.o.doc_hash, vasp: t1.o.vasp_id };
const vault: DataSource = { open: (t, p, f) => (t === T && p === 'originator' ? { value: hex(fieldMap[f]), salt: hex(t1.o.salt) } : undefined) };
const tok = gov.issue({ grant_id: 'g-BCB-001', supervisor: 'BCB (fictitious demo)', legal_basis: 'Fictitious supervisory inquiry 0001/2026', transfer_ids: [T], parties: ['originator'], scope: 1, expires_at: clock.t + 600 });
const show = (label: string, r: any) => console.log(`[2] ${label}: ${r.ok ? 'GRANTED fields=' + Object.keys(r.fields).join(',') : 'DENIED ' + r.reason}`);
show('BCB reads originator.name', gov.access(tok, { transfer_id: T, party: 'originator', fields: ['name'] }, vault));
show('BCB reads originator.document (out of scope)', gov.access(tok, { transfer_id: T, party: 'originator', fields: ['document'] }, vault));
// supervisor verifies opened name against the on-chain root
const cs = (['name', 'account', 'document', 'vasp'] as Field[]).map((f) => pureCircuits.field_commit(fieldMap[f], t1.o.salt, b32(f)));
console.log(`[2] supervisor recomputes originator root from opening: matches on-chain = ${hex(pureCircuits.root_of(cs[0], cs[1], cs[2], cs[3])) === hex(L.originator_root.lookup(ids.pass))}`);
clock.t += 601;
show('BCB after expiry (+601s)', gov.access(tok, { transfer_id: T, party: 'originator', fields: ['name'] }, vault));
clock.t += 1;
const tok2 = gov.issue({ grant_id: 'g-BCB-002', supervisor: 'BCB (fictitious demo)', legal_basis: 'Fictitious follow-up 0002/2026', transfer_ids: [T], parties: ['originator'], scope: 1, expires_at: clock.t + 600 });
show('BCB new grant before revoke', gov.access(tok2, { transfer_id: T, party: 'originator', fields: ['name'] }, vault));
gov.revoke('g-BCB-002', 'inquiry withdrawn');
show('BCB after revoke', gov.access(tok2, { transfer_id: T, party: 'originator', fields: ['name'] }, vault));
console.log('[2] log:', JSON.stringify(DisclosureGovernance.verifyLog(logPath)));
console.log('[2] events:', gov.log().map((e) => e.event + (e.detail.reason ? `(${e.detail.reason})` : '')).join(' > '));

// --- evidence pack
const packDir = path.join(work, 'evidence-pack');
const m = buildPack({ outDir: packDir, vaspName: 'Example VASP Ltda (fictitious)', attestations: atts, disclosureLogPath: logPath, generatedAt: new Date().toISOString() });
console.log('[3] pack_root', m.pack_root, 'files', m.files.length, 'verify', JSON.stringify(verifyPack(packDir)));
