/**
 * npx tsx scripts/evidence-pack.ts build  <outDir> --log <access-log.jsonl> --attestations <json> --inputs <json> [--scope <json>] [--no-due-diligence]
 *   --inputs: [{ name, source, retrievedAt, signedBy|null, hash }] covering party_data, sanctions_list,
 *   threshold and registry_attestation; --scope: { text, covers?, does_not_cover? } (default DEFAULT_SCOPE).
 *   (due diligence on by default: due-diligence/ from this repo's compact/, build/ keys and docs/DISCLOSURE-GOVERNANCE.md;
 *    needs bash scripts/compile.sh for the verifier key hashes)
 * npx tsx scripts/evidence-pack.ts verify <packDir>
 * Real VASPs are refused: the name is fixed to "Example VASP Ltda (fictitious)".
 */
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack, verifyPack } from '../src/evidence/pack.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'verify') {
  const r = verifyPack(dir);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'build') {
  const log = opt('--log'), att = opt('--attestations'), inp = opt('--inputs'), scope = opt('--scope');
  if (!log || !att || !inp) { console.error('build needs --log, --attestations and --inputs'); process.exit(64); }
  let commit: string | undefined;
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not in git */ }
  const m = buildPack({
    outDir: dir, vaspName: 'Example VASP Ltda (fictitious)', attestations: JSON.parse(fs.readFileSync(att, 'utf8')),
    disclosureLogPath: log, generatedAt: new Date().toISOString(), generator: { repo_commit: commit },
    inputs: JSON.parse(fs.readFileSync(inp, 'utf8')), ...(scope ? { scope: JSON.parse(fs.readFileSync(scope, 'utf8')) } : {}),
    ...(rest.includes('--no-due-diligence') ? {} : { dueDiligence: { repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } }),
  });
  console.log(JSON.stringify({ out: dir, pack_root: m.pack_root, files: m.files.length }));
} else {
  console.error('usage: build <outDir> --log L --attestations A --inputs I [--scope S] | verify <packDir>'); process.exit(64);
}
