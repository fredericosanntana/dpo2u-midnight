/**
 * Due-diligence section of the evidence pack, following the institutional due-diligence list for
 * Midnight deployments: architecture, circuit/policy specification, data flow, disclosure
 * governance, access model, evidence samples, key management and continuity, code/policy change,
 * and a CCO checklist where every item points at the artifact (file in this pack) that shows it.
 *
 * Generated from the repository (compact sources, compiled keys, role definitions, the governance
 * doc) and from the disclosure log, so the pack describes the code it was built from.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { allContractSpecs, specMarkdown, type ContractSpec } from './circuit-spec.js';
import { ROLE_DEFS } from '../disclosure/roles.js';
import type { LogEntry } from '../disclosure/governance.js';

export const DD_DIR = 'due-diligence';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export const ARCHITECTURE = `# Architecture

\`\`\`mermaid
flowchart LR
  subgraph VASP["VASP (operator)"]
    AG["Agent / operator CLI<br/>scripts/travel-rule-v10.ts, agent.ts"]
    VAULT[("Party data vault<br/>hashes + salts, off-chain")]
    DG["Disclosure governance<br/>src/disclosure: credentials, exceptions,<br/>role views, hash-chained log"]
    PS["Proof server<br/>(local, 127.0.0.1)"]
  end
  APPR["Approver (second key, e.g. DPO)<br/>outside the VPS"]
  subgraph CHAIN["Midnight network"]
    GATE["TravelRuleGate<br/>verdicts, roots, grants"]
    PASS["PsavPassport<br/>partner passports"]
    REG["ComplianceRegistry<br/>attestations, score commitments"]
    CONS["ConsentRegistry / DataSubjectRights<br/>salted subject keys"]
  end
  SUP["Supervisor (regulator role)"]
  AUD["Auditor / CCO"]
  VAULT -- witnesses --> AG
  AG -- prove --> PS
  AG -- evaluate / release / grant --> GATE
  GATE -- isValid --> PASS
  GATE -- hasAttestation --> REG
  APPR -- approveDisclosure --> GATE
  DG -- scoped credential --> SUP
  SUP -- verifies opening against root --> GATE
  DG -- evidence pack --> AUD
\`\`\`

Only commitments, verdicts, reason codes, policy and purpose hashes and grant metadata reach the chain. Party fields, amounts, screening detail and scores stay with the VASP; a supervisor receives single field openings under an approved grant and checks them against the on-chain root.
`;

export const DATA_FLOW = `# Data flow map

| Data item | Origin | Stored where | On-chain form | Who can see the value | Code |
|---|---|---|---|---|---|
| Party name / account / document (hashes) | VASP onboarding | VASP vault | per-field salted commitment, one root per party | supervisor, field by field, under an approved grant | \`TravelRuleGate.field_commit\`, \`DisclosureGovernance.access\` |
| Per-field salt | VASP | VASP vault | never | supervisor with the opening | witness \`originator_data\` / \`beneficiary_data\` |
| Counterparty VASP id | transfer | chain | public | everyone | \`attested_vasps\`, PsavPassport id |
| Amount | transfer | VASP | never (only above/below threshold via reason 2) | VASP | witness \`transfer_amount\` |
| Sanctions screening | VASP screening provider | VASP | never (boolean, VASP-attested) | VASP | witness \`sanctions_clear\` |
| Verdict, reason, status | gate | chain | public | everyone; compliance role sees FAILs | \`status\`, \`fail_reason\` |
| Policy version | VASP rules | chain | hash | everyone | \`verdict_policy\` |
| Disclosure purpose / legal basis | request | credential + log | hash | approver, supervisor, auditor | \`grant_purpose\`, \`purposeHash()\` |
| Compliance score | evaluation | never stored in clear | hiding commitment | the company / chosen auditor with the salt | \`attestation_score_commit\` |
| Evidence behind a score | evaluation | evaluation record | hash | auditor | \`attestation_evidence\` |
| Reviewer identity (LGPD) | reviewer | controller | salted hash in metadata | nobody from the chain | \`bridge/reviewer-salt.mjs\` |
| Data subject identifier | controller | controller | salted subject key | nobody from the chain | \`subject_key\` |
| Exceptions, access decisions, role views | disclosure service | hash-chained log | never | auditor, CCO | \`src/disclosure\` |
`;

export const KEYS = [
  { key: 'Owner secret (DPO2U_OWNER_SECRET)', holder: 'VASP operator', storage: 'outside the VPS on mainnet; explicit, never derived from the wallet seed', rotation: 'redeploy (owner_commit is fixed at deploy)', loss: 'no new evaluations/releases/grants; leak does not allow approving disclosures' },
  { key: 'Approver key (DPO2U_APPROVER_SECRET / _COMMIT)', holder: 'second person (e.g. DPO)', storage: 'outside the VPS; only the commitment is needed to deploy; stdin-only on mainnet', rotation: 'redeploy the gate with a new approver_commit', loss: 'grants cannot be approved; leak alone cannot create a request' },
  { key: 'Disclosure issuer key', holder: 'disclosure service', storage: 'mode-600 file (loadKey refuses wider)', rotation: 'new key; old credentials stop verifying', loss: 'reissue credentials' },
  { key: 'Per-grant key', holder: 'derived (HKDF of issuer key, grant, scope, expiry)', storage: 'never stored', rotation: 'per grant', loss: 'follows the issuer key' },
  { key: 'Reviewer salt (DPO2U_REVIEWER_SALT)', holder: 'controller', storage: 'outside the chain; required on mainnet', rotation: 'new salt for new attestations', loss: 'old reviewer links unrecoverable; leak makes reviewer hashes guessable' },
  { key: 'Score salt', holder: 'derived from owner secret + attestation context', storage: 'never stored', rotation: 'per attestation', loss: 'follows the owner secret' },
  { key: 'Wallet seed (MIDNIGHT_SEED)', holder: 'operator', storage: 'mode-600 file', rotation: 'new wallet, re-register DUST', loss: 'fees only; does not open data' },
  { key: 'Private state password (PRIVATE_STATE_PASSWORD)', holder: 'operator', storage: 'environment; required on mainnet', rotation: 'rewrite the local private state store', loss: 'local private state unreadable' },
];

export function keyManagementMd(): string {
  return ['# Key management and continuity', '', '| Key | Holder | Storage | Rotation | If lost or leaked |', '|---|---|---|---|---|',
    ...KEYS.map((k) => `| ${k.key} | ${k.holder} | ${k.storage} | ${k.rotation} | ${k.loss} |`), '',
    '**Continuity**: to resume operation you need the disclosure log, the issuer key file and `deployment-<network>-v9.json`; the public half lives on chain. Losing the owner or approver key means redeploying the gate and recording the change (change-management.md).', ''].join('\n');
}

export function accessModelMd(): string {
  return ['# Access model', '', 'Generated from `src/disclosure/roles.ts` (ROLE_DEFS). Every role view is logged as ROLE_VIEW in the disclosure log.', '',
    '| Role | Sees | Never sees | How |', '|---|---|---|---|',
    ...Object.entries(ROLE_DEFS).map(([r, d]) => `| ${r} | ${d.sees.join('; ')} | ${d.never.join('; ')} | ${d.how} |`), ''].join('\n');
}

export type ChangeRecord = {
  generated_at: string; repo_commit: string | null; compiler: string;
  contracts: { contract: string; source_sha256: string; verifier_keys: Record<string, string> }[];
  policy_hashes_in_use: string[];
};

export function changeRecord(repoRoot: string, specs: ContractSpec[], policyHashes: string[], generatedAt: string, commit?: string): ChangeRecord {
  const compileSh = path.join(repoRoot, 'scripts', 'compile.sh');
  const pin = fs.existsSync(compileSh) ? fs.readFileSync(compileSh, 'utf8').match(/COMPACT_VERSION:-([0-9.]+)/)?.[1] : undefined;
  return {
    generated_at: generatedAt, repo_commit: commit ?? null, compiler: pin ? `compactc ${pin}` : 'unknown',
    contracts: specs.map((s) => ({ contract: s.contract, source_sha256: s.source_sha256,
      verifier_keys: Object.fromEntries(s.circuits.filter((c) => c.verifier_key_sha256).map((c) => [c.name, c.verifier_key_sha256!])) })),
    policy_hashes_in_use: [...new Set(policyHashes)].sort(),
  };
}

export function changeManagementMd(c: ChangeRecord): string {
  return ['# Code and policy change', '',
    `- Repository commit: \`${c.repo_commit ?? 'unknown'}\``, `- Compiler: ${c.compiler}`, `- Policy hashes in use (verdict_policy): ${c.policy_hashes_in_use.map((p) => '`' + p.slice(0, 16) + '…`').join(', ') || 'none'}`, '',
    'A change to a circuit changes its verifier key hash (change-management.json) and requires a redeploy recorded in `deployment-<network>-v9.json` (codeVersion). A change to the Travel Rule policy changes the `policy_hash` passed to `evaluateTransfer`, so each verdict stays tied to the policy version that produced it. Both go through a pull request, the full test suite, and a new evidence pack.', '',
    '| Contract | Source sha256 | Circuits with verifier keys |', '|---|---|---|',
    ...c.contracts.map((x) => `| ${x.contract} | \`${x.source_sha256.slice(0, 16)}…\` | ${Object.keys(x.verifier_keys).length} |`), ''].join('\n');
}

/** CCO checklist: each item names the artifacts (pack-relative paths) that evidence it. */
export const CCO_CHECKLIST: { id: string; item: string; artifacts: string[] }[] = [
  { id: 'arch', item: 'System architecture and trust boundaries documented', artifacts: [`${DD_DIR}/architecture.md`] },
  { id: 'circuits', item: 'Every circuit specified: public vs private data, gating, cross-contract calls, pinned verifier keys', artifacts: [`${DD_DIR}/circuit-spec.json`, `${DD_DIR}/circuit-spec.md`] },
  { id: 'dataflow', item: 'Data flow: where each data item lives and what reaches the chain', artifacts: [`${DD_DIR}/data-flow.md`] },
  { id: 'governance', item: 'Disclosure governance: what, who, legal basis, scope, keys, log/retention/revocation/exit', artifacts: [`${DD_DIR}/disclosure-governance.md`] },
  { id: 'access', item: 'Access model by role, least privilege, views logged', artifacts: [`${DD_DIR}/access-model.md`, 'disclosure-log.jsonl'] },
  { id: 'samples', item: 'Evidence samples: verdicts with policy hash, access decisions, exceptions', artifacts: ['attestations.json', 'disclosure-log.jsonl', `${DD_DIR}/exceptions.json`] },
  { id: 'log', item: 'Tamper-evident log, independently re-verified', artifacts: ['disclosure-log.jsonl', 'disclosure-log.verification.json'] },
  { id: 'exceptions', item: 'Every FAIL and refused attestation has an owner, due date, decision and justification', artifacts: [`${DD_DIR}/exceptions.json`] },
  { id: 'keys', item: 'Key management, separation of duties (owner vs approver) and continuity', artifacts: [`${DD_DIR}/key-management.md`] },
  { id: 'change', item: 'Code and policy change control: commit, compiler, verifier key and policy hashes', artifacts: [`${DD_DIR}/change-management.json`, `${DD_DIR}/change-management.md`] },
  { id: 'integrity', item: 'Pack integrity: every file hashed in the manifest, root hash over all', artifacts: ['manifest.json'] },
];

export function ccoChecklistMd(): string {
  return ['# CCO checklist', '', 'Each item is evidenced by the listed files of this pack (hashes in manifest.json; `evidence-pack verify` checks that every listed file is present and unchanged).', '',
    '| # | Item | Evidence |', '|---|---|---|', ...CCO_CHECKLIST.map((c, i) => `| ${i + 1} | ${c.item} | ${c.artifacts.map((a) => '`' + a + '`').join(', ')} |`), ''].join('\n');
}

/** Current state of every exception, rebuilt from the log entries (same rule as DisclosureGovernance). */
export function exceptionsFromLog(entries: LogEntry[]) {
  const m = new Map<string, any>();
  for (const e of entries) {
    if (e.event === 'EXCEPTION_OPEN') m.set(e.grant_id, { ...(e.detail.item as object) });
    if (e.event === 'EXCEPTION_DECIDE' && m.has(e.grant_id)) Object.assign(m.get(e.grant_id), { status: 'decided', decision: e.detail.decision, decided_by: e.supervisor, decided_at: e.ts, justification: e.detail.justification });
  }
  return [...m.values()];
}

/** Writes the due-diligence files into <outDir>/due-diligence; returns their pack-relative paths. */
export function writeDueDiligence(outDir: string, o: { repoRoot: string; governanceDoc?: string; logEntries: LogEntry[]; policyHashes: string[]; generatedAt: string; commit?: string }): string[] {
  const dd = path.join(outDir, DD_DIR);
  fs.mkdirSync(dd, { recursive: true });
  const specs = allContractSpecs(o.repoRoot);
  const change = changeRecord(o.repoRoot, specs, o.policyHashes, o.generatedAt, o.commit);
  const gov = o.governanceDoc ?? path.join(o.repoRoot, 'docs', 'DISCLOSURE-GOVERNANCE.md');
  if (!fs.existsSync(gov)) throw new Error(`governance doc missing: ${gov}`);
  const files: Record<string, string> = {
    'architecture.md': ARCHITECTURE,
    'circuit-spec.json': JSON.stringify(specs, null, 2) + '\n',
    'circuit-spec.md': specMarkdown(specs),
    'data-flow.md': DATA_FLOW,
    'disclosure-governance.md': fs.readFileSync(gov, 'utf8'),
    'access-model.md': accessModelMd(),
    'exceptions.json': JSON.stringify(exceptionsFromLog(o.logEntries), null, 2) + '\n',
    'key-management.md': keyManagementMd(),
    'change-management.json': JSON.stringify(change, null, 2) + '\n',
    'change-management.md': changeManagementMd(change),
    'cco-checklist.json': JSON.stringify(CCO_CHECKLIST, null, 2) + '\n',
    'cco-checklist.md': ccoChecklistMd(),
  };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dd, n), c);
  return Object.keys(files).map((n) => `${DD_DIR}/${n}`);
}

export { sha as sha256Hex };
