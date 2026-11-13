/**
 * Examiner evidence pack generator + verifier.
 * Output dir: manifest.json, README.md, attestations.json, disclosure-log.jsonl,
 * disclosure-log.verification.json. Every file is listed in the manifest with its sha256 and
 * the manifest carries a pack root hash over (path, sha256) pairs.
 * Only FICTITIOUS VASPs are accepted in this version: the name must carry "(fictitious)".
 * With `dueDiligence` the pack also carries due-diligence/ (src/evidence/due-diligence.ts):
 * architecture, circuit spec generated from the code, data flow, disclosure governance, access
 * model, exceptions, key management, change record and a CCO checklist whose every item points at
 * files of the pack; verifyPack then also checks that each referenced file is in the manifest.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DisclosureGovernance, type LogEntry } from '../disclosure/governance.js';
import { writeDueDiligence, DD_DIR } from './due-diligence.js';

export const PACK_SCHEMA = 'dpo2u.evidence-pack/1';
export const PACK_VERSION = '1.0.0';

export interface Attestation {
  id: string;
  type: 'travel_rule_verdict';
  transfer_id: string;
  verdict: 'PASS' | 'FAIL' | 'RELEASED';
  reason_code: number;
  originator_root: string;       // hex, salted commitment root (no PII)
  beneficiary_root: string;
  policy_hash?: string;          // hex, TravelRuleGate.verdict_policy: the rule/policy version behind the verdict (v10)
  source: 'simulator' | 'chain';
  contract_address: string | null;
  tx_hash: string | null;
}

/**
 * What the pack proves and what it does not. Every pack declares it in the manifest; verifyPack
 * fails without it. Override `scope` only to narrow it further, never to claim more.
 */
export const DEFAULT_SCOPE = {
  text: 'This pack shows that each verdict was produced by the named compiled circuits, from inputs whose hashes are listed here, under the policy version given, and that the disclosure log is intact. It does NOT show that the input data were true or complete, that the policy was current or adequate when applied, or that the processing was lawful; those remain with the VASP, its auditor and the supervisor.',
  covers: ['circuit execution and verdict integrity', 'binding of each verdict to its policy hash', 'hashes of the inputs used', 'disclosure log integrity'],
  does_not_cover: ['truthfulness or completeness of input data', 'currency or adequacy of the policy', 'lawfulness of the processing'],
};

/** One input of the verdicts in this pack: where it came from, when, who signed it (if anyone), its hash. */
export interface PackInputRecord {
  name: string;                  // e.g. party_data, sanctions_list, threshold, registry_attestation
  source: string;                // system / provider / contract it was read from
  retrievedAt: string;           // ISO 8601
  signedBy: string | null;       // signer identity or key, null when unsigned (say so, never omit)
  hash: string;                  // sha256 hex of the input as used
}

/** Inputs every Travel Rule pack must declare. */
export const REQUIRED_INPUTS = ['party_data', 'sanctions_list', 'threshold', 'registry_attestation'] as const;

/** Checks scope / policyVersion / inputs; returns the problems (empty = valid). */
export function checkDeclaredScope(m: { scope?: any; policyVersion?: unknown; inputs?: any }, attestations: { policy_hash?: string }[]): string[] {
  const e: string[] = [];
  if (!m.scope || typeof m.scope.text !== 'string' || m.scope.text.trim().length < 40) e.push('scope.text missing (what the proof covers and does not cover)');
  else if (!/not/i.test(m.scope.text)) e.push('scope.text must state what the proof does NOT cover');
  if (!('policyVersion' in m)) e.push('policyVersion missing');
  const hashes = [...new Set(attestations.map((a) => a.policy_hash).filter(Boolean))];
  if (hashes.length > 1) e.push(`attestations carry ${hashes.length} policy hashes: one pack per policy version`);
  const want = hashes[0] ?? null;
  if ('policyVersion' in m && m.policyVersion !== want) e.push(`policyVersion ${String(m.policyVersion)} does not match the verdicts' policy_hash ${String(want)}`);
  if (!Array.isArray(m.inputs) || m.inputs.length === 0) { e.push('inputs[] missing'); return e; }
  m.inputs.forEach((x: any, i: number) => {
    if (!x?.name) e.push(`inputs[${i}].name missing`);
    if (!x?.source) e.push(`inputs[${i}].source missing`);
    if (!x?.retrievedAt || Number.isNaN(Date.parse(x.retrievedAt))) e.push(`inputs[${i}].retrievedAt must be an ISO date`);
    if (!('signedBy' in (x ?? {})) || !(x.signedBy === null || (typeof x.signedBy === 'string' && x.signedBy))) e.push(`inputs[${i}].signedBy must be a signer or null`);
    if (!/^[0-9a-f]{64}$/.test(String(x?.hash))) e.push(`inputs[${i}].hash must be sha256 hex`);
  });
  for (const r of REQUIRED_INPUTS) if (!m.inputs.some((x: any) => x?.name === r)) e.push(`inputs: ${r} not declared`);
  return e;
}

export interface PackInput {
  outDir: string;
  vaspName: string;
  attestations: Attestation[];
  disclosureLogPath: string;
  generatedAt: string;           // ISO
  generator?: { repo_commit?: string };
  dueDiligence?: { repoRoot: string; governanceDoc?: string };
  inputs: PackInputRecord[];     // required: every input behind the verdicts
  scope?: { text: string; covers?: string[]; does_not_cover?: string[] };
}

const sha256File = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rootOf = (files: { path: string; sha256: string }[]) =>
  createHash('sha256').update([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex');

export function buildPack(i: PackInput) {
  if (!/\(fictitious\)\s*$/i.test(i.vaspName)) throw new Error('vaspName must end with "(fictitious)": real VASP data is not supported in this version');
  const scope = i.scope ?? DEFAULT_SCOPE;
  const policyHashes = [...new Set(i.attestations.map((a) => a.policy_hash).filter((x): x is string => !!x))];
  const declared = { scope, policyVersion: policyHashes[0] ?? null, inputs: i.inputs };
  const bad = checkDeclaredScope(declared, i.attestations);
  if (bad.length) throw new Error('evidence pack scope: ' + bad.join('; '));
  const ver = DisclosureGovernance.verifyLog(i.disclosureLogPath);
  if (!ver.ok) throw new Error('disclosure log failed chain verification: ' + ver.error);
  fs.mkdirSync(i.outDir, { recursive: true });

  fs.writeFileSync(path.join(i.outDir, 'attestations.json'), JSON.stringify(i.attestations, null, 2) + '\n');
  fs.copyFileSync(i.disclosureLogPath, path.join(i.outDir, 'disclosure-log.jsonl'));
  fs.writeFileSync(path.join(i.outDir, 'disclosure-log.verification.json'), JSON.stringify({ ...ver, verified_at: i.generatedAt }, null, 2) + '\n');

  const onchain = i.attestations.filter((a) => a.source === 'chain').length;
  const readme = `# Evidence pack: ${i.vaspName}

**FICTITIOUS ENTITY. This pack contains no real customer, VASP or supervisor data.**

- Pack schema / version: \`${PACK_SCHEMA}\` / \`${PACK_VERSION}\`
- Generated at: ${i.generatedAt}
- Scope: ${scope.text}
- Policy version: ${declared.policyVersion ? '\`' + declared.policyVersion + '\`' : 'none recorded'}
- Inputs: ${i.inputs.map((x) => `${x.name} (from ${x.source}, ${x.retrievedAt}, ${x.signedBy ? 'signed by ' + x.signedBy : 'unsigned'})`).join('; ')}
- Attestations: ${i.attestations.length} (${onchain} anchored on-chain, ${i.attestations.length - onchain} from the local contract simulator, labelled per entry in \`source\`)
- Disclosure log: ${ver.entries} entries, hash-chained, head \`${ver.head}\`
${i.dueDiligence ? `- Due diligence: \`${DD_DIR}/\` (start at \`${DD_DIR}/cco-checklist.md\`)
` : ''}
## Files
| File | What it is |
|---|---|
| \`manifest.json\` | File list with sha256, pack root hash, versions |
| \`attestations.json\` | Travel Rule verdicts (PASS/FAIL), the policy hash behind each verdict, salted commitment roots only, no PII |
| \`disclosure-log.jsonl\` | Append-only log of every supervisor access decision (granted and denied) |
| \`disclosure-log.verification.json\` | Result of re-verifying the log hash chain at generation time |

## How to verify
\`\`\`
tsx scripts/evidence-pack.ts verify ${path.basename(i.outDir)}
\`\`\`
Recomputes every file hash, the pack root hash, and the disclosure-log chain. Any edit to any file fails the check.

## Limits (read before relying on this)
- Entries with \`source: "simulator"\` were produced by executing the compiled Compact contract locally, not on a network. They prove the rule logic, not an on-chain record.
- Sanctions screening is attested by the VASP, not proven inside the circuit.
- The pack is a sample of the format; it is not legal advice nor a regulatory filing.
`;
  fs.writeFileSync(path.join(i.outDir, 'README.md'), readme);

  const names = ['attestations.json', 'disclosure-log.jsonl', 'disclosure-log.verification.json', 'README.md'];
  if (i.dueDiligence) {
    const entries: LogEntry[] = fs.readFileSync(i.disclosureLogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    names.push(...writeDueDiligence(i.outDir, {
      repoRoot: i.dueDiligence.repoRoot, governanceDoc: i.dueDiligence.governanceDoc, logEntries: entries,
      policyHashes: i.attestations.map((a) => a.policy_hash).filter((x): x is string => !!x), generatedAt: i.generatedAt, commit: i.generator?.repo_commit,
    }));
  }
  const files = names.map((n) => ({ path: n, sha256: sha256File(path.join(i.outDir, n)), bytes: fs.statSync(path.join(i.outDir, n)).size }));
  const manifest = {
    schema: PACK_SCHEMA,
    pack_version: PACK_VERSION,
    generated_at: i.generatedAt,
    vasp: { name: i.vaspName, fictitious: true },
    ...declared,
    attestation_count: i.attestations.length,
    attestations_onchain: onchain,
    disclosure_log: { entries: ver.entries, head: ver.head, chain_verified: true },
    ...(i.dueDiligence ? { due_diligence: { dir: DD_DIR, checklist: `${DD_DIR}/cco-checklist.json` } } : {}),
    generator: i.generator ?? {},
    files,
    pack_root: rootOf(files),
  };
  fs.writeFileSync(path.join(i.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function verifyPack(dir: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (m.schema !== PACK_SCHEMA) errors.push('unknown schema ' + m.schema);
  if (!m.vasp?.fictitious) errors.push('pack is not marked fictitious');
  let atts: { policy_hash?: string }[] = [];
  try { atts = JSON.parse(fs.readFileSync(path.join(dir, 'attestations.json'), 'utf8')); } catch { errors.push('attestations.json unreadable'); }
  errors.push(...checkDeclaredScope(m, atts));
  for (const f of m.files) {
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) { errors.push('missing ' + f.path); continue; }
    if (sha256File(p) !== f.sha256) errors.push('hash mismatch ' + f.path);
  }
  if (rootOf(m.files) !== m.pack_root) errors.push('pack_root mismatch');
  if (m.due_diligence) {
    // Every checklist item must point at files that are in the manifest (so their hashes were checked above).
    const listed = new Set<string>([...m.files.map((f: any) => f.path), 'manifest.json']);
    const cl = path.join(dir, m.due_diligence.checklist);
    if (!listed.has(m.due_diligence.checklist) || !fs.existsSync(cl)) errors.push('CCO checklist missing from the manifest');
    else for (const item of JSON.parse(fs.readFileSync(cl, 'utf8'))) {
      for (const a of item.artifacts) if (!listed.has(a)) errors.push(`checklist item ${item.id}: artifact ${a} not in the manifest`);
    }
  }
  const log = DisclosureGovernance.verifyLog(path.join(dir, 'disclosure-log.jsonl'));
  if (!log.ok) errors.push('disclosure log chain: ' + log.error);
  else if (log.head !== m.disclosure_log.head) errors.push('disclosure log head differs from manifest');
  return { ok: errors.length === 0, errors };
}
