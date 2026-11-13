/**
 * Examiner evidence pack generator + verifier.
 * Output dir: manifest.json, README.md, attestations.json, disclosure-log.jsonl,
 * disclosure-log.verification.json. Every file is listed in the manifest with its sha256 and
 * the manifest carries a pack root hash over (path, sha256) pairs.
 * Only FICTITIOUS VASPs are accepted in this version: the name must carry "(fictitious)".
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DisclosureGovernance } from '../disclosure/governance.js';

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
  source: 'simulator' | 'chain';
  contract_address: string | null;
  tx_hash: string | null;
}

export interface PackInput {
  outDir: string;
  vaspName: string;
  attestations: Attestation[];
  disclosureLogPath: string;
  generatedAt: string;           // ISO
  generator?: { repo_commit?: string };
}

const sha256File = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rootOf = (files: { path: string; sha256: string }[]) =>
  createHash('sha256').update([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex');

export function buildPack(i: PackInput) {
  if (!/\(fictitious\)\s*$/i.test(i.vaspName)) throw new Error('vaspName must end with "(fictitious)": real VASP data is not supported in this version');
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
- Attestations: ${i.attestations.length} (${onchain} anchored on-chain, ${i.attestations.length - onchain} from the local contract simulator, labelled per entry in \`source\`)
- Disclosure log: ${ver.entries} entries, hash-chained, head \`${ver.head}\`

## Files
| File | What it is |
|---|---|
| \`manifest.json\` | File list with sha256, pack root hash, versions |
| \`attestations.json\` | Travel Rule verdicts (PASS/FAIL), salted commitment roots only, no PII |
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
  const files = names.map((n) => ({ path: n, sha256: sha256File(path.join(i.outDir, n)), bytes: fs.statSync(path.join(i.outDir, n)).size }));
  const manifest = {
    schema: PACK_SCHEMA,
    pack_version: PACK_VERSION,
    generated_at: i.generatedAt,
    vasp: { name: i.vaspName, fictitious: true },
    attestation_count: i.attestations.length,
    attestations_onchain: onchain,
    disclosure_log: { entries: ver.entries, head: ver.head, chain_verified: true },
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
  for (const f of m.files) {
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) { errors.push('missing ' + f.path); continue; }
    if (sha256File(p) !== f.sha256) errors.push('hash mismatch ' + f.path);
  }
  if (rootOf(m.files) !== m.pack_root) errors.push('pack_root mismatch');
  const log = DisclosureGovernance.verifyLog(path.join(dir, 'disclosure-log.jsonl'));
  if (!log.ok) errors.push('disclosure log chain: ' + log.error);
  else if (log.head !== m.disclosure_log.head) errors.push('disclosure log head differs from manifest');
  return { ok: errors.length === 0, errors };
}
