/**
 * npx tsx scripts/evidence-pack.ts build  <outDir> [--log <access-log.jsonl>] [--attestations <json>]
 * npx tsx scripts/evidence-pack.ts verify <packDir>
 * Real VASPs are refused: the name is fixed to "Example VASP Ltda (fictitious)".
 */
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { buildPack, verifyPack } from '../src/evidence/pack.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'verify') {
  const r = verifyPack(dir);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'build') {
  const log = opt('--log'), att = opt('--attestations');
  if (!log || !att) { console.error('build needs --log and --attestations'); process.exit(64); }
  let commit: string | undefined;
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not in git */ }
  const m = buildPack({
    outDir: dir, vaspName: 'Example VASP Ltda (fictitious)', attestations: JSON.parse(fs.readFileSync(att, 'utf8')),
    disclosureLogPath: log, generatedAt: new Date().toISOString(), generator: { repo_commit: commit },
  });
  console.log(JSON.stringify({ out: dir, pack_root: m.pack_root, files: m.files.length }));
} else {
  console.error('usage: build <outDir> --log L --attestations A | verify <packDir>'); process.exit(64);
}
