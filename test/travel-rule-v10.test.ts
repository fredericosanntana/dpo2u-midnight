/**
 * scripts/lib/travel-rule-v10.ts — the network-free part of operating the v10 gate: deployment
 * reading, the module provider handed to midnight-js-contracts (exercised here in the simulator),
 * approver-key rules, witness parsing, grant status and the --plan output.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCircuitContext, createConstructorContext, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import * as Gate from '../build/TravelRuleGate/contract/index.js';
import * as Passport from '../build/PsavPassport/contract/index.js';
import * as Registry from '../build/ComplianceRegistry/contract/index.js';
import { simAddress, contractRef, asDeployed, SIM_BLOCK_HASH } from './helpers.js';
import {
  readGateDeployment, moduleProviderFor, zkDirs, plan, b32, hashArg, idArg, hex,
  parseTransferWitness, resolveApproverSecret, checkApproverAgainstLedger, grantStatus,
} from '../scripts/lib/travel-rule-v10.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CPK = '0'.repeat(64);
const T0 = 1_800_000_000;
const GATE = simAddress(0x6a7e), PASSPORT = simAddress(0x9a55), REGISTRY = simAddress(0x4e61);
const OWNER = b32('owner-secret-test-only'), APPROVER = b32('approver-secret-test-only');
const SELF = b32('company:example-vasp');
const PASSPORT_VASP = 'vasp:with-passport';

function depFile(entry: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trv10-'));
  const f = path.join(d, 'deployment-preview-v9.json');
  fs.writeFileSync(f, JSON.stringify({ network: 'preview', contracts: { TravelRuleGate: entry, PsavPassport: { contractAddress: PASSPORT }, ComplianceRegistry: { contractAddress: REGISTRY } } }));
  return f;
}
const V10 = { contractAddress: GATE, accessControl: 'owner-v1', codeVersion: 'v10', links: { PsavPassport: PASSPORT, ComplianceRegistry: REGISTRY } };

const run = async (c: any, circuit: string, state: any, ps: any, ...args: unknown[]) =>
  (await c.circuits[circuit](createCircuitContext({ circuitId: circuit, contractAddress: simAddress(0xffff), coinPublicKeyOrZswapState: CPK, contractState: state, privateState: ps, time: T0 } as any), ...args)).context.callContext.currentQueryContext.state;

/** Simulated chain: passport with one valid id, registry with SELF attested, v10 gate linked to both. */
async function chain() {
  const iss = b32('issuer');
  const pps = { secret: iss };
  const pw: any = { owner_secret: (x: any) => [x.privateState, iss], rule_origins: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]], rule_verdicts: (x: any) => [x.privateState, [1n, ...Array(15).fill(0n)]],
    partner_id: (x: any) => [x.privateState, b32('p')], commit_salt: (x: any) => [x.privateState, b32('s')], reviewer_sig_hash: (x: any) => [x.privateState, new Uint8Array(32)],
    evidence_hash: (x: any) => [x.privateState, b32('e')], sponsor_secret: (x: any) => [x.privateState, b32('x')] };
  const p = new Passport.Contract(pw);
  const pInit = (await p.initialState(createConstructorContext(pps, CPK), Passport.pureCircuits.owner_commitment(iss))).currentContractState;
  const pState = await run(p, 'issuePassport', pInit.data, pps, idArg(PASSPORT_VASP), b32('pack'), b32('1.0.0'), 0n, BigInt(T0 - 60), BigInt(T0 - 60 + 31_536_000));
  const rs = b32('reg');
  const r = new Registry.Contract({ owner_secret: (x: any) => [x.privateState, rs], score_salt: (x: any) => [x.privateState, b32('salt')] } as any);
  const rInit = (await r.initialState(createConstructorContext({}, CPK), Registry.pureCircuits.owner_commitment(rs))).currentContractState;
  const rState = await run(r, 'attestCompliance', rInit.data, {}, SELF, b32('did'), b32('cid'), 70n, b32('ctx'), 80n, b32('ev'));
  const states: Record<string, any> = { [PASSPORT]: asDeployed(pInit, pState, 'PsavPassport'), [REGISTRY]: asDeployed(rInit, rState, 'ComplianceRegistry') };
  const gate = new Gate.Contract({
    originator_data: (x: any) => [x.privateState, x.privateState.o], beneficiary_data: (x: any) => [x.privateState, x.privateState.b],
    transfer_amount: (x: any) => [x.privateState, 250_000n], sanctions_clear: (x: any) => [x.privateState, true],
    owner_secret: (x: any) => [x.privateState, OWNER], approver_secret: (x: any) => [x.privateState, x.privateState.approver ?? APPROVER],
  } as any);
  const gInit = (await gate.initialState(createConstructorContext({}, CPK), Gate.pureCircuits.owner_commitment(OWNER), 100_000n,
    contractRef(PASSPORT), contractRef(REGISTRY), SELF, Gate.pureCircuits.approver_commitment(APPROVER))).currentContractState;
  // The SAME module provider the CLI hands the SDK, with a state provider standing in for the indexer.
  const crossContract = { stateProvider: { getContractState: async (_h: string, a: string) => states[a] }, moduleProvider: moduleProviderFor(ROOT, { PsavPassport: PASSPORT, ComplianceRegistry: REGISTRY }) };
  const mk = (state: any, ps: any) => createCircuitContext({ circuitId: 't', contractAddress: GATE, coinPublicKeyOrZswapState: CPK, contractState: state, privateState: ps, time: T0, parentBlockHash: SIM_BLOCK_HASH, crossContract } as any);
  return { gate, gInit, mk };
}

const party = (n: string, vasp: string) => ({ name_hash: hex(hashArg('name:' + n)), account_hash: hex(hashArg('acct:' + n)), doc_hash: hex(hashArg('doc:' + n)), vasp_id: vasp, salt: hex(hashArg('salt:' + n)) });

describe('travel-rule-v10: deployment', () => {
  it('reads the gate and its links; refuses a pre-v10 gate and a missing link', () => {
    const d = readGateDeployment(ROOT, 'preview', depFile(V10));
    assert.equal(d.gate, GATE);
    assert.deepEqual(d.links, { PsavPassport: PASSPORT, ComplianceRegistry: REGISTRY });
    assert.throws(() => readGateDeployment(ROOT, 'preview', depFile({ ...V10, codeVersion: undefined })), /pre-v10 layout/);
    const f = depFile({ ...V10, links: { PsavPassport: PASSPORT } });
    const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.contracts.ComplianceRegistry; fs.writeFileSync(f, JSON.stringify(j));
    assert.throws(() => readGateDeployment(ROOT, 'preview', f), /link to ComplianceRegistry missing/);
  });

  it('the current preview file still has the pre-v10 gate (needs the v10 redeploy first)', () => {
    assert.throws(() => readGateDeployment(ROOT, 'preview'), /pre-v10 layout/);
  });
});

describe('travel-rule-v10: cross-contract wiring', () => {
  it('module provider resolves only the linked callees, to modules the runtime accepts', async () => {
    const mp = moduleProviderFor(ROOT, { PsavPassport: PASSPORT, ComplianceRegistry: REGISTRY });
    assert.equal(mp.resolve(simAddress(0x1234)), undefined);
    const m: any = await mp.resolve(PASSPORT.toUpperCase())!();
    assert.equal(typeof m.Contract, 'function');
    assert.ok(m.expectedVk?.isValid && m.circuitSignatures?.isValid, 'callee module carries the tables crossContractCall checks');
    const r: any = await mp.resolve(REGISTRY)!();
    assert.ok(r.circuitSignatures?.hasAttestation);
  });

  it('with that provider: passport-only counterparty PASSes, release passes the registry check', async () => {
    const { gate, gInit, mk } = await chain();
    const T = idArg('transfer-1');
    const ps = { o: parseTransferWitness({ originator: party('o', 'vasp:own'), beneficiary: party('b', PASSPORT_VASP), amount_cents: 250000, sanctions_clear: true }).o,
      b: parseTransferWitness({ originator: party('o', 'vasp:own'), beneficiary: party('b', PASSPORT_VASP), amount_cents: 250000, sanctions_clear: true }).b };
    const e = await gate.circuits.evaluateTransfer(mk(gInit, ps), T, hashArg('policy:v1'));
    assert.equal(e.result, 1n);
    const rel = await gate.circuits.releaseTransfer(mk(e.context.callContext.currentQueryContext.state, ps), T);
    assert.equal(Gate.ledger(rel.context.callContext.currentQueryContext.state).status.lookup(T), 3n);
  });

  it('the gate ledger exposes the linked addresses the CLI checks against the deployment file', async () => {
    const { gInit } = await chain();
    const L = Gate.ledger(gInit.data);
    assert.equal(hex(L.passport.bytes), hex(encodeContractAddress(PASSPORT)));
    assert.equal(hex(L.registry.bytes), hex(encodeContractAddress(REGISTRY)));
  });

  it('ZK sources cover the gate and both callees, with the keys of the called circuits', () => {
    const dirs = zkDirs(ROOT);
    assert.deepEqual(dirs.map((d) => path.basename(d)), ['TravelRuleGate', 'PsavPassport', 'ComplianceRegistry']);
    for (const [d, f] of [[dirs[1], 'isValid'], [dirs[2], 'hasAttestation'], [dirs[0], 'evaluateTransfer']]) {
      assert.ok(fs.existsSync(path.join(d, 'keys', `${f}.prover`)), `${f}.prover missing in ${d}`);
    }
  });
});

describe('travel-rule-v10: approver key', () => {
  it('mainnet takes the approver secret from stdin only; format is checked', () => {
    const s = '22'.repeat(32);
    assert.throws(() => resolveApproverSecret('mainnet', { env: s }), /--approver-secret-stdin/);
    assert.equal(hex(resolveApproverSecret('mainnet', { stdin: s + '\n' })), s);
    assert.equal(hex(resolveApproverSecret('preview', { env: s })), s);
    assert.throws(() => resolveApproverSecret('preview', {}), /Approver secret missing/);
    assert.throws(() => resolveApproverSecret('preview', { env: 'abc' }), /32 bytes of hex/);
  });

  it('refuses the owner secret and a secret that does not open approver_commit', async () => {
    const { gInit } = await chain();
    const L = Gate.ledger(gInit.data);
    assert.throws(() => checkApproverAgainstLedger(Gate, OWNER, L), /owner cannot approve/);
    assert.throws(() => checkApproverAgainstLedger(Gate, b32('someone'), L), /does not open/);
    assert.doesNotThrow(() => checkApproverAgainstLedger(Gate, APPROVER, L));
  });
});

describe('travel-rule-v10: witnesses, grant status, plan', () => {
  it('witness file must hold hashes, not raw values', () => {
    const ok = { originator: party('o', 'vasp:own'), beneficiary: party('b', PASSPORT_VASP), amount_cents: '250000', sanctions_clear: true };
    const w = parseTransferWitness(ok);
    assert.equal(w.amount, 250_000n);
    assert.deepEqual(w.b.vasp_id, idArg(PASSPORT_VASP));
    assert.throws(() => parseTransferWitness({ ...ok, originator: { ...ok.originator, name_hash: 'Maria Silva' } }), /must be 32 bytes of hex/);
    assert.throws(() => parseTransferWitness({ ...ok, sanctions_clear: 'yes' as any }), /sanctions_clear/);
  });

  it('grant status: requested -> inactive, approved -> active, expired -> inactive', async () => {
    const { gate, gInit, mk } = await chain();
    const T = idArg('transfer-1'), G = idArg('grant-1');
    const ps = { o: parseTransferWitness({ originator: party('o', 'vasp:own'), beneficiary: party('b', PASSPORT_VASP), amount_cents: 1, sanctions_clear: true }).o, b: parseTransferWitness({ originator: party('o', 'vasp:own'), beneficiary: party('b', PASSPORT_VASP), amount_cents: 1, sanctions_clear: true }).b };
    const e = await gate.circuits.evaluateTransfer(mk(gInit, ps), T, hashArg('policy:v1'));
    const g = await gate.circuits.grantDisclosure(mk(e.context.callContext.currentQueryContext.state, ps), G, T, idArg('supervisor:BCB'), 1n, BigInt(T0 + 3600), hashArg('purpose'));
    const s1 = grantStatus(Gate.ledger(g.context.callContext.currentQueryContext.state), G, T0);
    assert.equal(s1.known && !s1.approved && !s1.active, true);
    assert.equal(s1.purpose_hash, hex(hashArg('purpose')));
    const a = await gate.circuits.approveDisclosure(mk(g.context.callContext.currentQueryContext.state, ps), G);
    const La = Gate.ledger(a.context.callContext.currentQueryContext.state);
    assert.equal(grantStatus(La, G, T0).active, true);
    assert.equal(grantStatus(La, G, T0 + 7200).active, false);
    assert.equal(grantStatus(La, idArg('nope'), T0).known, false);
  });

  it('plan: evaluate/release carry the cross-contract call and the three ZK sources; grant does not', () => {
    const d = readGateDeployment(ROOT, 'preview', depFile(V10));
    const ev = plan(ROOT, d, 'evaluate', {});
    assert.equal(ev.circuit, 'evaluateTransfer');
    assert.match(String(ev.crossContract), /PsavPassport.isValid/);
    assert.deepEqual(ev.zkSources, ['build/TravelRuleGate', 'build/PsavPassport', 'build/ComplianceRegistry']);
    assert.equal(ev.moduleProvider?.[PASSPORT], 'build/PsavPassport/contract/index.js');
    assert.match(String(plan(ROOT, d, 'release', {}).crossContract), /hasAttestation/);
    const gr = plan(ROOT, d, 'grant', {});
    assert.equal(gr.crossContract, null);
    assert.deepEqual(gr.zkSources, ['build/TravelRuleGate']);
    assert.match(plan(ROOT, d, 'approve', {}).key, /never the owner/);
    assert.equal(plan(ROOT, d, 'attest-self', {}).address, REGISTRY);
  });
});
